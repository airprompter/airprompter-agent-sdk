"""Where an agent reads its root document when ``sync.root_url`` is not set. A pinned AirPrompter root
(``HOSTED_ROOTS``) reads its own environment's ``root.json``; any other pinned root refuses to start a syncing runtime,
saying what to add; a runtime that never syncs needs none; an explicit ``root_url`` wins. The default moves where the
document is fetched from, never what is trusted: a document that does not verify against the pin is refused exactly
as before.

The fake cannot sign as AirPrompter, so a test that needs a hosted root puts the fake's key in ``HOSTED_ROOTS`` for
its duration (``monkeypatch``). The real table is checked on its own, against the ceremonies' documents.
"""

from __future__ import annotations

import json
import os
from typing import Any, Callable, Optional

import httpx
import pytest

from airprompter_agent import AirPrompterAgent
from airprompter_agent.agent import AgentStartError, SyncOptions
from airprompter_agent.core import HOSTED_ROOT_URLS, HOSTED_ROOTS, hosted_environment_of_root, key_thumbprint, root_url_for, trusted_root_from_pinned_key, verify_root_metadata
from airprompter_agent.core.protocol.trust import public_jwk_of

from .control_plane import FakeControlPlane, new_key, root_document

SCOPE = {"organizationId": "org_1", "agentId": "agt_1", "target": "prod"}
PROD_URL = "https://api.airprompter.com/roots/prod/root.json"
DEV_URL = "https://api.airprompter.dev/roots/dev/root.json"
REAL = {"dev": HOSTED_ROOTS["dev"], "prod": HOSTED_ROOTS["prod"]}
#: The ceremonies' documents, as the TypeScript side keeps them (the service repository's, byte for byte).
FIXTURES = os.path.join(os.path.dirname(__file__), "..", "..", "sdk-typescript", "test", "frameworks", "steps", "fixtures")


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


def served(ap: AirPrompterAgent) -> Optional[str]:
    try:
        return ap.prompt("support.reply").render().version_id
    except Exception:  # noqa: BLE001
        return None
    finally:
        ap.stop()


def root_urls(requests: list[str]) -> list[str]:
    return sorted({url for url in requests if url.endswith("/root.json")})


def test_the_hosted_tables_prod_and_dev_only_on_airprompters_api_hosts():
    assert dict(HOSTED_ROOT_URLS) == {"dev": DEV_URL, "prod": PROD_URL}
    with pytest.raises(TypeError):
        HOSTED_ROOT_URLS["prod"] = "https://elsewhere.test/root.json"  # type: ignore[index]
    assert key_thumbprint(REAL["prod"]) == "044af6e83353a2ea3758cc3feb3b1b7031c82bda5d6cd9287ba7730363e11793"
    assert key_thumbprint(REAL["dev"]) == "86267aa3dc49005a0c1474d5c9c06bd7e1d0e835da715a864c1eca706545df91"
    assert hosted_environment_of_root(REAL["prod"]) == "prod" and hosted_environment_of_root(REAL["dev"]) == "dev"
    assert hosted_environment_of_root(public_jwk_of(new_key())) is None
    assert hosted_environment_of_root({"kty": "EC", "crv": "P-256", "x": "not", "y": "a key"}) is None
    # The real documents each ceremony signed verify under the key the URL is chosen for, and not under the other.
    docs = {}
    for name in ("dev", "prod"):
        with open(os.path.join(FIXTURES, f"hosted-{name}-root.json"), encoding="utf-8") as f:
            docs[name] = json.load(f)
    under = lambda key, env: trusted_root_from_pinned_key(purpose="platform", environment=env, pinned_root=key)  # noqa: E731
    assert verify_root_metadata(candidate=docs["prod"], trusted=under(REAL["prod"], "prod"), now="2026-11-28T00:00:00.000Z").ok
    assert verify_root_metadata(candidate=docs["dev"], trusted=under(REAL["dev"], "dev"), now="2026-11-16T00:00:00.000Z").ok
    assert not verify_root_metadata(candidate=docs["dev"], trusted=under(REAL["prod"], "prod"), now="2026-11-16T00:00:00.000Z").ok
    assert not verify_root_metadata(candidate=docs["prod"], trusted=under(REAL["dev"], "dev"), now="2026-11-28T00:00:00.000Z").ok


def test_the_rule():
    stranger = public_jwk_of(new_key())
    assert root_url_for(root_url="https://mirror.test/r.json", pinned=REAL["prod"], hosted_environment=None, syncs=True) == ("https://mirror.test/r.json", None)
    assert root_url_for(root_url=None, pinned=REAL["prod"], hosted_environment=None, syncs=True) == (PROD_URL, "prod")
    assert root_url_for(root_url=None, pinned=REAL["dev"], hosted_environment="dev", syncs=True) == (DEV_URL, "dev")
    assert root_url_for(root_url=None, pinned=REAL["prod"], hosted_environment=None, syncs=False) == (None, None)
    assert root_url_for(root_url=None, pinned=stranger, hosted_environment=None, syncs=False) == (None, None)
    assert root_url_for(root_url=None, pinned=None, hosted_environment=None, syncs=True) == (None, None)
    # A dev pin never reads prod's URL, nor a prod pin dev's: the environment named must be the pin's own.
    assert root_url_for(root_url=None, pinned=REAL["dev"], hosted_environment=None, syncs=True) == 'root["pinned"] is AirPrompter\'s dev root, but root["hosted_environment"] is "prod" (the default). Add "hosted_environment": "dev" to root, or pin the prod root.'
    assert root_url_for(root_url=None, pinned=REAL["prod"], hosted_environment="dev", syncs=True) == 'root["pinned"] is AirPrompter\'s prod root, but root["hosted_environment"] is "dev". Add "hosted_environment": "prod" to root, or pin the dev root.'
    assert root_url_for(root_url=None, pinned=stranger, hosted_environment=None, syncs=True) == 'root["pinned"] is not one of AirPrompter\'s hosted roots, so the SDK cannot know where its root document is, and without it no release verifies. Add sync={"root_url": "https://<your service>/roots/prod/root.json"}, the root document of the service that signs your releases.'
    assert 'sync={"root_url": "https://<your service>/roots/staging/root.json"}' in root_url_for(root_url=None, pinned=stranger, hosted_environment="staging", syncs=True)


def test_a_custom_pinned_root_with_no_root_url_fails_fast_before_the_store_opens(tmp_path):
    plane = promoted()
    state_dir = tmp_path / "state"
    with pytest.raises(AgentStartError) as refused:
        start(plane, str(state_dir))
    assert refused.value.code == "invalid_options"
    assert 'Add sync={"root_url": "https://<your service>/roots/prod/root.json"}' in str(refused.value)
    assert not state_dir.exists(), "nothing was opened or written"
    assert plane.requests == [], "nothing was fetched"


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


def test_a_hosted_prod_pin_with_no_root_url_reads_prods_root_json(tmp_path, monkeypatch):
    plane = promoted()
    monkeypatch.setitem(HOSTED_ROOTS, "prod", public_jwk_of(plane.root_key))
    events: list = []
    assert served(start(plane, str(tmp_path), events)) == "ver_reply_1"
    assert root_urls(plane.requests) == [PROD_URL]
    assert any(e.get("event") == "root_url_default" and e.get("environment") == "prod" for e in events)


def test_a_hosted_dev_pin_with_hosted_environment_dev_reads_devs_root_json(tmp_path, monkeypatch):
    plane = promoted({**SCOPE, "target": "staging"}, hosted_environment="dev")
    monkeypatch.setitem(HOSTED_ROOTS, "dev", public_jwk_of(plane.root_key))
    assert served(start(plane, str(tmp_path), root={"pinned": public_jwk_of(plane.root_key), "hosted_environment": "dev"})) == "ver_reply_1"
    assert root_urls(plane.requests) == [DEV_URL]


def test_a_pin_named_for_the_other_environment_fails_fast(tmp_path, monkeypatch):
    plane = promoted()
    key = public_jwk_of(plane.root_key)
    monkeypatch.setitem(HOSTED_ROOTS, "dev", key)
    with pytest.raises(AgentStartError, match='Add "hosted_environment": "dev" to root'):
        start(plane, str(tmp_path / "a"))
    monkeypatch.setitem(HOSTED_ROOTS, "dev", REAL["dev"])
    monkeypatch.setitem(HOSTED_ROOTS, "prod", key)
    with pytest.raises(AgentStartError, match='Add "hosted_environment": "prod" to root'):
        start(plane, str(tmp_path / "b"), root={"pinned": key, "hosted_environment": "dev"})
    assert plane.requests == []


def test_an_explicit_root_url_wins(tmp_path, monkeypatch):
    plane = promoted()
    monkeypatch.setitem(HOSTED_ROOTS, "prod", public_jwk_of(plane.root_key))
    events: list = []
    assert served(start(plane, str(tmp_path), events, sync=SyncOptions(mode="resident", poll_seconds=3600, root_url="https://mirror.test/roots/prod/root.json"))) == "ver_reply_1"
    assert root_urls(plane.requests) == ["https://mirror.test/roots/prod/root.json"]
    assert not any(e.get("event") == "root_url_default" for e in events)


def hijacked(plane: FakeControlPlane, serve: Callable[[], dict]) -> httpx.MockTransport:
    """The default URL answered by someone else: ``serve`` decides what comes back for it; everything else is the plane."""
    base = plane.transport()

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == PROD_URL:
            plane.requests.append(PROD_URL)
            return httpx.Response(200, json=serve())
        return base.handle_request(request)

    return httpx.MockTransport(handler)


def test_what_the_default_url_serves_is_trusted_only_if_it_verifies_against_the_pin(tmp_path, monkeypatch):
    plane = promoted()
    key = public_jwk_of(plane.root_key)
    monkeypatch.setitem(HOSTED_ROOTS, "prod", key)
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
