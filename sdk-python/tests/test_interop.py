"""Cross-language interop: a store the TypeScript SDK wrote (file key, an
encrypted A slot, a closed spool segment) opens in this SDK — the same
KEK wrap, the same payload AAD, the same manifest verification, the same
segment names — and a ``run_ref`` minted there parses here with the same
per-store key derivation. Runs when ``node`` and the TypeScript SDK's
dev dependencies are present (CI installs them; locally it skips otherwise).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import shutil
import subprocess
import tempfile

import pytest

from airprompter_agent.agent import AirPrompterAgent
from airprompter_agent_core.render.run_ref import parse_run_ref
from airprompter_agent_telemetry.spool.writer import epoch_minute
from airprompter_agent_core._util import instant

HERE = os.path.dirname(__file__)
TS_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "sdk-typescript"))
FIXTURE = os.path.join(HERE, "interop", "write_ts_store.mts")


def _node_available() -> bool:
    return shutil.which("node") is not None and os.path.isdir(os.path.join(TS_DIR, "node_modules", "tsx"))


@pytest.mark.skipif(not _node_available(), reason="node + sdk-typescript/node_modules (npm ci) needed for the cross-language store fixture")
def test_store_written_by_typescript_opens_here():
    state_dir = tempfile.mkdtemp(prefix="ap-interop-")
    try:
        completed = subprocess.run(["node", "--import", "tsx", FIXTURE, state_dir], cwd=TS_DIR, capture_output=True, text=True, check=True, timeout=120)
        expected = json.loads(completed.stdout)
        ap = AirPrompterAgent.start(organization_id="org_1", agent_id="agt_1", target="prod", state_dir=state_dir, root={"pinned": expected["pinnedRoot"]})
        try:
            assert ap.generation == expected["generation"]
            assert ap.instance_id != expected["instanceId"], "S6: the process's id is its own, never the store's"
            assert ap._run_ref_key == hmac.new(expected["instanceId"].encode("utf-8"), b"runRef", hashlib.sha256).digest(), "the runRef key is the store's, shared by every process on the host"
            assert ap.status().signing_key_id == expected["signingKeyId"]
            assert ap.status().storage_protection == "file_key"
            assert ap.manifest["payload"]["releaseDigest"] == expected["releaseDigest"]
            assert ap.prompt("support.triage").render(team="Billing", ticket="x").text == expected["texts"]["support.triage"].replace("{{team}}", "Billing").replace("{{ticket}}", "<ticket>x</ticket>")
            assert ap.prompt("support.reply").render(name="Bo").text == "Reply politely to Bo."
            facts = parse_run_ref(expected["runRef"], ap._run_ref_key)
            assert facts is not None and facts.tag == "support.triage" and facts.generation == 1, "a run_ref minted by TypeScript parses under the Python-derived key"
            assert ap.feedback(expected["runRef"], thumbs="up") is True
            spool_dir = os.path.join(state_dir, "airprompter", "agt_1", "prod", "spool", "telemetry")
            segments = sorted(n for n in os.listdir(spool_dir) if n.startswith("seg-") and n.endswith(".ndjson"))
            assert segments == [f"seg-{expected['instanceId']}-{epoch_minute(instant('2026-09-12T14:04:10Z'))}-0.ndjson"]
        finally:
            ap.stop()
        # And after this SDK wrote to it (feedback closes into a new segment on stop), the layout is still one the daemon reads.
        segments_after = sorted(n for n in os.listdir(os.path.join(state_dir, "airprompter", "agt_1", "prod", "spool", "telemetry")) if n.startswith("seg-"))
        assert len(segments_after) >= 1 and not any(n.endswith(".open") for n in segments_after)
    finally:
        shutil.rmtree(state_dir, ignore_errors=True)
