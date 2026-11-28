"""Where an agent reads its root document when ``sync.root_url`` is not set. A pinned AirPrompter root
(``HOSTED_ROOTS``) reads its own environment's ``root.json``; any other pinned root refuses to start a syncing runtime,
saying what to add, unless a vendored bundle or the datastore carries the keys; a runtime that never syncs needs none;
an explicit ``root_url`` wins. The default moves where the document is fetched from, never what is trusted: a
document that does not verify against the pin is refused exactly as before, and one that is not a root document at all
does not stop the pass.

The fake cannot sign as AirPrompter, so a test that needs a hosted root has the fake's key recognised as one
(``hosted_roots._RECOGNISED``, through ``monkeypatch``). The real table is checked on its own, against the ceremonies'
documents.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Callable, Optional

import httpx
import pytest

from airprompter_agent import AirPrompterAgent
from airprompter_agent.agent import AgentStartError, SyncOptions
from airprompter_agent.core import HOSTED_ROOTS, create_plaintext_bundle, hosted_environment_of_root, key_thumbprint, trusted_root_from_pinned_key, verify_root_metadata
from airprompter_agent.core._util import b64url_encode
from airprompter_agent.core.protocol import hosted_roots
from airprompter_agent.core.protocol.trust import public_jwk_of

from .control_plane import FakeControlPlane, new_key, root_document

SCOPE = {"organizationId": "org_1", "agentId": "agt_1", "target": "prod"}
PROD_URL = "https://api.airprompter.com/roots/prod/root.json"
DEV_URL = "https://api.airprompter.dev/roots/dev/root.json"
REAL = {"dev": dict(HOSTED_ROOTS["dev"]), "prod": dict(HOSTED_ROOTS["prod"])}
#: The ceremonies' documents, as the TypeScript side keeps them (the service repository's, byte for byte).
FIXTURES = os.path.join(os.path.dirname(__file__), "..", "..", "sdk-typescript", "test", "frameworks", "steps", "fixtures")


def as_hosted(monkeypatch: pytest.MonkeyPatch, environment: str, key: dict) -> None:
    monkeypatch.setattr(hosted_roots, "_RECOGNISED", {**HOSTED_ROOTS, environment: key})


def promoted(scope: dict = SCOPE, hosted_environment: Optional[str] = None) -> FakeControlPlane:
    plane = FakeControlPlane(scope, hosted_environment=hosted_environment)
    plane.promote([plane.slot(tag="support.reply", text="Reply politely.", version_id="ver_reply_1")])
    return plane


def start(plane: FakeControlPlane, state_dir: str, events: Optional[list] = None, transport: Optional[httpx.BaseTransport] = None, **extra: Any) -> AirPrompterAgent:
    options: dict[str, Any] = {
        "organization_id": plane.scope["organizationId"], "agent_id": plane.scope["agentId"], "target": plane.scope["target"],
        "api_key": plane.api_key, "state_dir": state_dir, "root": {"pinned": public_jwk_of(plane.root_key)},
        "sync": SyncOptions(mode="resident", poll_seconds=3600), "transport": transport or plane.transport(),
        "telemetry": {"sink": "memory"}, "logger": (events if events is not None else []).append,
    }
    options.update(extra)
    return AirPrompterAgent.start(**options)


def refusal(plane: FakeControlPlane, state_dir: str, **extra: Any) -> str:
    with pytest.raises(AgentStartError) as refused:
        start(plane, state_dir, **extra)
    assert refused.value.code == "invalid_options"
    return str(refused.value)


def served(ap: AirPrompterAgent) -> Optional[str]:
    try:
        return ap.prompt("support.reply").render().version_id
    except Exception:  # noqa: BLE001
        return None
    finally:
        ap.stop()


def root_urls(requests: list[str]) -> list[str]:
    return sorted({url for url in requests if url.endswith("/root.json")})


def test_the_hosted_table_prod_and_dev_read_only_the_ceremonies_keys():
    assert sorted(HOSTED_ROOTS) == ["dev", "prod"]
    with pytest.raises(TypeError):
        HOSTED_ROOTS["prod"] = {}  # type: ignore[index]
    with pytest.raises(TypeError):
        HOSTED_ROOTS["prod"]["x"] = "other"  # type: ignore[index]
    assert key_thumbprint(REAL["prod"]) == "044af6e83353a2ea3758cc3feb3b1b7031c82bda5d6cd9287ba7730363e11793"
    assert key_thumbprint(REAL["dev"]) == "86267aa3dc49005a0c1474d5c9c06bd7e1d0e835da715a864c1eca706545df91"
    assert hosted_environment_of_root(REAL["prod"]) == "prod" and hosted_environment_of_root(REAL["dev"]) == "dev"
    assert hosted_environment_of_root(public_jwk_of(new_key())) is None
    assert hosted_environment_of_root({"kty": "EC", "crv": "P-256", "x": "not", "y": "a key"}) is None
    # The real documents each ceremony signed verify under the key their URL is chosen for, and not under the other.
    docs = {}
    for name in ("dev", "prod"):
        with open(os.path.join(FIXTURES, f"hosted-{name}-root.json"), encoding="utf-8") as f:
            docs[name] = json.load(f)
    under = lambda key, env: trusted_root_from_pinned_key(purpose="platform", environment=env, pinned_root=key)  # noqa: E731
    assert verify_root_metadata(candidate=docs["prod"], trusted=under(REAL["prod"], "prod"), now="2026-11-28T00:00:00.000Z").ok
    assert verify_root_metadata(candidate=docs["dev"], trusted=under(REAL["dev"], "dev"), now="2026-11-16T00:00:00.000Z").ok
    assert not verify_root_metadata(candidate=docs["dev"], trusted=under(REAL["prod"], "prod"), now="2026-11-16T00:00:00.000Z").ok
    assert not verify_root_metadata(candidate=docs["prod"], trusted=under(REAL["dev"], "dev"), now="2026-11-28T00:00:00.000Z").ok


def test_a_custom_pinned_root_with_no_root_url_fails_fast_before_the_store_opens(tmp_path):
    plane = promoted()
    state_dir = tmp_path / "state"
    assert refusal(plane, str(state_dir)) == 'root["pinned"] is not one of AirPrompter\'s hosted roots, so the SDK cannot know where its root document is, and without it this runtime cannot learn the keys that sign your releases. Add sync={"root_url": "https://<your service>/roots/prod/root.json"}, the root document of the service that signs them.'
    assert not state_dir.exists(), "nothing was opened or written"
    assert plane.requests == [], "nothing was fetched"
    # The environment named is the one in the path; a base_url is named back as the likely answer.
    assert 'sync={"root_url": "https://<your service>/roots/staging/root.json"}' in refusal(plane, str(tmp_path / "b"), root={"pinned": public_jwk_of(plane.root_key), "hosted_environment": "staging"})
    assert refusal(plane, str(tmp_path / "c"), base_url="http://127.0.0.1:4180/").endswith("For the service at http://127.0.0.1:4180 that is usually http://127.0.0.1:4180/roots/prod/root.json.")


def test_a_runtime_that_never_syncs_needs_no_root_url(tmp_path):
    plane = promoted()
    for i, extra in enumerate([{"api_key": None}, {"sync": SyncOptions(mode="offline")}]):
        ap = start(plane, str(tmp_path / f"s{i}"), **extra)
        assert ap.status().generation == 0
        ap.stop()
    assert plane.requests == []
    # A full root document already names the signing keys: it starts and serves, as before.
    assert served(start(plane, str(tmp_path / "doc"), root=plane.root)) == "ver_reply_1"
    assert root_urls(plane.requests) == []


def test_a_custom_pin_with_a_vendored_bundle_starts_serves_and_says_a_rotation_will_be_refused(tmp_path):
    plane = promoted()
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    bundle = create_plaintext_bundle({"createdAt": now, "notAfter": "2027-12-01T00:00:00.000Z", "manifest": plane.manifest, "keySet": plane.root, "payloads": [{"contentHash": h, "byteLength": len(b), "bytes": b64url_encode(b)} for h, b in plane.payloads.items()]})
    events: list = []
    assert served(start(plane, str(tmp_path), events, vendored_bundle={"bundle": bundle})) == "ver_reply_1"
    missing = next((e for e in events if e.get("event") == "root_url_missing"), None)
    assert missing is not None, [e.get("event") for e in events]
    assert 'Add sync={"root_url":' in missing["hint"] and missing["hint"].endswith("a release signed after a key rotation is refused.")


def test_a_hosted_prod_pin_with_no_root_url_reads_prods_root_json(tmp_path, monkeypatch):
    plane = promoted()
    as_hosted(monkeypatch, "prod", public_jwk_of(plane.root_key))
    events: list = []
    assert served(start(plane, str(tmp_path), events)) == "ver_reply_1"
    assert root_urls(plane.requests) == [PROD_URL]
    assert any(e.get("event") == "root_url_default" and e.get("environment") == "prod" and e.get("rootUrl") == PROD_URL for e in events)


def test_a_hosted_dev_pin_with_hosted_environment_dev_reads_devs_root_json(tmp_path, monkeypatch):
    plane = promoted({**SCOPE, "target": "staging"}, hosted_environment="dev")
    as_hosted(monkeypatch, "dev", public_jwk_of(plane.root_key))
    assert served(start(plane, str(tmp_path), root={"pinned": public_jwk_of(plane.root_key), "hosted_environment": "dev"})) == "ver_reply_1"
    assert root_urls(plane.requests) == [DEV_URL]


def test_a_pin_named_for_the_other_environment_fails_fast(tmp_path):
    plane = promoted()
    assert refusal(plane, str(tmp_path / "a"), root={"pinned": REAL["dev"]}) == 'root["pinned"] is AirPrompter\'s dev root, but root["hosted_environment"] is "prod" (the default). Add "hosted_environment": "dev" to root, or pin the prod root.'
    assert refusal(plane, str(tmp_path / "b"), root={"pinned": REAL["prod"], "hosted_environment": "dev"}) == 'root["pinned"] is AirPrompter\'s prod root, but root["hosted_environment"] is "dev". Add "hosted_environment": "prod" to root, or pin the dev root.'
    # None is the default, as in TypeScript: the URL and the trusted root agree on prod.
    assert 'is "prod" (the default)' in refusal(plane, str(tmp_path / "c"), root={"pinned": REAL["dev"], "hosted_environment": None})
    assert plane.requests == []


def test_an_explicit_root_url_wins(tmp_path, monkeypatch):
    plane = promoted()
    as_hosted(monkeypatch, "prod", public_jwk_of(plane.root_key))
    events: list = []
    assert served(start(plane, str(tmp_path), events, sync=SyncOptions(mode="resident", poll_seconds=3600, root_url="https://mirror.test/roots/prod/root.json"))) == "ver_reply_1"
    assert root_urls(plane.requests) == ["https://mirror.test/roots/prod/root.json"]
    assert not any(e.get("event") == "root_url_default" for e in events)


def hijacked(plane: FakeControlPlane, serve: Callable[[], Any], seen: Optional[list] = None) -> httpx.MockTransport:
    """The default URL answered by someone else: ``serve`` decides what comes back for it; everything else is the plane."""
    base = plane.transport()

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == PROD_URL:
            plane.requests.append(PROD_URL)
            if seen is not None:
                seen.append(dict(request.headers))
            reply = serve()
            if reply == 304:
                return httpx.Response(304)
            return httpx.Response(200, content=reply if isinstance(reply, str) else json.dumps(reply), headers={"etag": '"root-1"'})
        return base.handle_request(request)

    return httpx.MockTransport(handler)


def test_what_the_default_url_serves_is_trusted_only_if_it_verifies_against_the_pin(tmp_path, monkeypatch):
    plane = promoted()
    key = public_jwk_of(plane.root_key)
    as_hosted(monkeypatch, "prod", key)
    # A stranger's root naming its own signing key, and a manifest signed by that key: neither is trusted.
    stranger = FakeControlPlane(SCOPE)
    stranger.promote([stranger.slot(tag="support.reply", text="Say what I say.", version_id="ver_forged")])
    events: list = []
    assert served(start(stranger, str(tmp_path / "a"), events, transport=hijacked(stranger, lambda: stranger.root), root={"pinned": key})) is None
    assert any(e.get("reason") == "root_signature_invalid" for e in events), events
    assert any(e.get("reason") == "unknown_signing_key" for e in events)

    # The pinned root's own key, signing a document for the dev deployment, served at prod's URL: wrong scope.
    dev_scoped = root_document(root_key=plane.root_key, signing_keys=[plane.signing_key], environment="dev")
    scoped: list = []
    assert served(start(plane, str(tmp_path / "b"), scoped, transport=hijacked(plane, lambda: dev_scoped))) is None
    assert any(e.get("reason") == "root_scope_mismatch" for e in scoped)

    # A rollback: once version 2 is accepted, version 1 from the same URL is refused and version 2 stays trusted.
    v2 = root_document(root_key=plane.root_key, signing_keys=[plane.signing_key], environment="prod", version=2)
    v1 = root_document(root_key=plane.root_key, signing_keys=[new_key()], environment="prod", version=1)
    serving = {"doc": v2}
    rolled: list = []
    ap = start(plane, str(tmp_path / "c"), rolled, transport=hijacked(plane, lambda: serving["doc"]))
    try:
        assert ap.prompt("support.reply").render().version_id == "ver_reply_1"
        serving["doc"] = v1
        ap.sync_now()
        assert any(e.get("reason") == "root_rollback" for e in rolled), rolled
        assert ap.prompt("support.reply").render().version_id == "ver_reply_1", "still serving under version 2"
    finally:
        ap.stop()


def test_a_root_url_answering_something_other_than_a_root_document_does_not_stop_the_pass(tmp_path, monkeypatch):
    plane = promoted()
    as_hosted(monkeypatch, "prod", public_jwk_of(plane.root_key))
    serving: dict = {"doc": plane.root}
    events: list = []
    ap = start(plane, str(tmp_path), events, transport=hijacked(plane, lambda: serving["doc"]))
    try:
        assert ap.prompt("support.reply").render().version_id == "ver_reply_1"
        for i, junk in enumerate([{"hello": 1}, [1], "null", '"text"', {"signed": {}}]):
            serving["doc"] = junk
            plane.promote([plane.slot(tag="support.reply", text=f"Reply {i}.", version_id=f"ver_reply_{i + 2}")])
            ap.sync_now()
            assert ap.prompt("support.reply").render().version_id == f"ver_reply_{i + 2}", f"the pass went on to the manifest after {junk!r}"
        assert any(e.get("event") == "sync_refused" and e.get("reason") == "root_signature_invalid" for e in events)
    finally:
        ap.stop()


def test_the_root_document_is_read_conditionally(tmp_path, monkeypatch):
    plane = promoted()
    as_hosted(monkeypatch, "prod", public_jwk_of(plane.root_key))
    seen: list = []
    answer: dict = {"reply": plane.root}
    ap = start(plane, str(tmp_path), transport=hijacked(plane, lambda: answer["reply"], seen))
    try:
        answer["reply"] = 304
        ap.sync_now()
        assert "if-none-match" not in seen[0], "the first read is unconditional"
        assert seen[-1].get("if-none-match") == '"root-1"'
        assert ap.prompt("support.reply").render().version_id == "ver_reply_1"
    finally:
        ap.stop()


def test_a_refused_root_document_keeps_no_etag(tmp_path, monkeypatch):
    plane = promoted()
    as_hosted(monkeypatch, "prod", public_jwk_of(plane.root_key))
    seen: list = []
    clock = {"ms": datetime(2028, 6, 1, tzinfo=timezone.utc).timestamp() * 1000}  # past the fake root's expiry
    events: list = []
    ap = start(plane, str(tmp_path), events, transport=hijacked(plane, lambda: plane.root, seen), now=lambda: clock["ms"], sync=SyncOptions(mode="on_invoke"))
    try:
        assert any(e.get("reason") == "root_expired" for e in events), events
        clock["ms"] = datetime.now(timezone.utc).timestamp() * 1000
        ap.sync_now()
        assert "if-none-match" not in seen[1], "the refused document is read again in full"
        assert ap.prompt("support.reply").render().version_id == "ver_reply_1"
        ap.sync_now()
        assert seen[2].get("if-none-match") == '"root-1"', "an accepted document is read conditionally"
    finally:
        ap.stop()


def test_the_refusal_names_a_base_url_back_without_credentials(tmp_path):
    message = refusal(promoted(), str(tmp_path), base_url="https://ops:s3cret@registry.internal.test/")
    assert "s3cret" not in message and "ops:" not in message
    assert message.endswith("that is usually https://registry.internal.test/roots/prod/root.json.")
