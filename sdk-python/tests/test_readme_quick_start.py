"""The README's quick start, run as written against the fake control plane: it must reach an approved, verified render,
so the docs cannot drift from the code. The block is read out of ``README.md`` on every run.

Three things in it cannot run verbatim, and each is replaced by exact text, once: the two id placeholders (``"org_…"``,
``"agt_…"``) and AirPrompter's production root key, because the fake cannot sign as AirPrompter. The key is first
checked to BE the production root (``HOSTED_ROOTS["prod"]``), and the fake's key is then recognised as the hosted prod
root (``hosted_roots._RECOGNISED``), so the default the README relies on (root.json from ``https://api.airprompter.com/roots/prod/root.json``) is the path
taken. The start options the block builds reach ``AirPrompterAgent.start`` unchanged; the test adds only where the
process runs (the fake's transport, a temporary ``state_dir``, a memory spool, a logger), and the block may set none of
those itself. ``openai`` is the fake client the adapter tests use, since the provider is the application's own.
"""

from __future__ import annotations

import ast
import os
import re
import sys
import types

from airprompter_agent import AirPrompterAgent
from airprompter_agent.core import HOSTED_ROOTS
from airprompter_agent.core.protocol import hosted_roots
from airprompter_agent.core.protocol.trust import public_jwk_of

from .control_plane import FakeControlPlane
from .fake_clients import FakeOpenAI

README = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "README.md")
ROOT_LITERAL = re.compile(r'root=\{"pinned": (\{[^{}]*\})\}')
PROD_URL = "https://api.airprompter.com/roots/prod/root.json"


def quick_start() -> str:
    with open(README, encoding="utf-8") as f:
        text = f.read()
    section = re.split(r"\n#{2,} ", text.split("\n## Quick start\n")[1])[0]  # up to the next heading of any level
    assert len(re.findall(r"^```", section, re.M)) == 2, "the Quick start has exactly one code block"
    block = re.search(r"^```python\n(.*?)\n```$", section, re.S | re.M)
    assert block, "the Quick start has a python block"
    return block.group(1)


def once(text: str, find: str, replace: str) -> str:
    assert text.count(find) == 1, f"the quick start has {find!r} exactly once"
    return text.replace(find, replace)


def test_the_quick_start_pins_airprompters_production_root_and_needs_nothing_else():
    code = quick_start()
    literal = ROOT_LITERAL.search(code)
    assert literal, "the quick start pins a root key inline"
    assert ast.literal_eval(literal.group(1)) == dict(HOSTED_ROOTS["prod"]), "the key shown is HOSTED_ROOTS['prod'], byte for byte"
    assert not re.search(r"root_url|hosted_environment|base_url|edge_pointer_url", code), "the hosted defaults are what the quick start relies on"
    assert not re.search(r"…/|<token>", code), "no URL placeholder a reader would have to fill"


def test_the_quick_start_run_as_written_serves_the_approved_release_through_the_default_root_url(tmp_path, monkeypatch):
    plane = FakeControlPlane({"organizationId": "org_quickstart", "agentId": "agt_quickstart", "target": "prod"})
    plane.promote([
        plane.slot(tag="support.triage", text="Route this {{ticket}} to {{team}}.", model="gpt-5", version_id="ver_triage_approved",
                   variables=[{"name": "team", "required": True, "trust": "operator"}, {"name": "ticket", "required": True, "trust": "end_user"}]),
    ])
    code = quick_start()
    code = once(code, '"org_…"', repr(plane.scope["organizationId"]))
    code = once(code, '"agt_…"', repr(plane.scope["agentId"]))
    shown = ROOT_LITERAL.search(code).group(1)
    assert ast.literal_eval(shown) == dict(HOSTED_ROOTS["prod"]), "the key the run stands the fake in for is AirPrompter's production root"
    code = once(code, shown, repr(public_jwk_of(plane.root_key)))

    events: list = []
    as_written: dict = {}
    real_start = AirPrompterAgent.start

    added = {"transport": plane.transport(), "state_dir": str(tmp_path / "state"), "telemetry": {"sink": "memory"}, "logger": events.append}

    def start(**options):
        as_written.update(options)
        for key in added:
            assert key not in options, f"the quick start sets {key}, which this test supplies"
        return real_start(**options, **added)

    clients: list = []

    def make_client():
        clients.append(FakeOpenAI())
        return clients[-1]

    monkeypatch.setattr(AirPrompterAgent, "start", staticmethod(start))
    monkeypatch.setitem(sys.modules, "openai", types.SimpleNamespace(OpenAI=make_client))
    monkeypatch.setenv("AIRPROMPTER_AGENT_KEY", plane.api_key)
    # The fake's root is recognised as AirPrompter's prod root, so the agent takes the hosted default.
    monkeypatch.setattr(hosted_roots, "_RECOGNISED", {**HOSTED_ROOTS, "prod": public_jwk_of(plane.root_key)})
    namespace: dict = {"user_message": "Where is my refund?", "user_id": "user-42"}
    try:
        exec(compile(code, README, "exec"), namespace)  # noqa: S102 — the README's own block
        ap, r = namespace["ap"], namespace["r"]
        assert as_written and "sync" in as_written
        assert not (as_written["sync"] or {}).get("root_url"), "no root URL was given: the default carried it"

        # An approved render, not a passthrough: the promoted version, its text, at generation 1.
        assert (r.version_id, r.generation, r.model) == ("ver_triage_approved", 1, "gpt-5")
        assert r.text == "Route this <ticket>Where is my refund?</ticket> to Billing."
        observed, adapted = clients
        assert observed.calls[0]["messages"][0]["content"] == r.text, "the provider was sent the approved text"
        placed = adapted.calls[0]
        assert placed["model"] == "gpt-5" and placed["messages"][0] == {"role": "system", "content": r.text}, "the adapter placed the approved text"
        assert ap.status().generation == 1

        # The signing keys came from the hosted root URL, and only from there.
        assert sorted({url for url in plane.requests if url.endswith("/root.json")}) == [PROD_URL], plane.requests
        assert any(e.get("event") == "root_url_default" and e.get("environment") == "prod" and e.get("rootUrl") == PROD_URL for e in events)
        assert not any(e.get("reason") == "unknown_signing_key" for e in events), "every manifest verified"
    finally:
        if "ap" in namespace:
            namespace["ap"].stop()
