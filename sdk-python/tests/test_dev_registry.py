"""S12 parity: the Python SDK syncs from ``airprompter dev`` exactly as from the hosted service — the dev root pins,
the manifest verifies, a save is a generation the runtime follows within a poll, and ``unlock_required`` set in
``release.json`` is honoured locally (staged, then ``unlock()``). The dev server is the TypeScript CLI run from source
(node + tsx from sdk-typescript/node_modules, as the interop test does)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time

import pytest

from airprompter_agent import AirPrompterAgent, SyncOptions

HERE = os.path.dirname(__file__)
TS_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "sdk-typescript"))
CLI_MAIN = os.path.abspath(os.path.join(HERE, "..", "..", "cli", "src", "main.ts"))


def _node_available() -> bool:
    return shutil.which("node") is not None and os.path.isdir(os.path.join(TS_DIR, "node_modules", "tsx"))


def _wait(check, label, timeout=20.0):
    start = time.time()
    while not check():
        if time.time() - start > timeout:
            raise AssertionError(f"timed out waiting for {label}")
        time.sleep(0.05)


class DevServer:
    def __init__(self, directory: str):
        self.process = subprocess.Popen(["node", "--import", "tsx", CLI_MAIN, "dev", directory, "--port", "0", "--json"], cwd=TS_DIR, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        line = self.process.stdout.readline()
        if not line:
            raise AssertionError(f"airprompter dev did not start: {self.process.stderr.read()}")
        self.facts = json.loads(line)

    def stop(self) -> None:
        self.process.terminate()
        self.process.wait(timeout=10)


@pytest.mark.skipif(not _node_available(), reason="node + sdk-typescript/node_modules (npm ci) needed to run airprompter dev from source")
def test_python_sdk_syncs_from_airprompter_dev_and_honours_unlock_required_locally():
    work = tempfile.mkdtemp(prefix="ap-dev-py-")
    prompts = os.path.join(work, "prompts")
    os.makedirs(os.path.join(prompts, "support"))
    with open(os.path.join(prompts, "support", "triage.md"), "w", encoding="utf-8") as f:
        f.write("---\nmodel: claude-sonnet-5\nvariables: ticket!, customer?\n---\nTriage {{ticket}} from {{customer}}.\n")
    server = DevServer(prompts)
    try:
        facts = server.facts
        with open(facts["root"], encoding="utf-8") as f:
            pinned = json.load(f)
        assert "d" not in pinned, "the public root carries no private part"
        state_dir = os.path.join(work, "state")
        ap = AirPrompterAgent.start(
            organization_id="org_dev",
            agent_id="agt_dev",
            target="dev",
            api_key=facts["apiKey"],
            base_url=facts["baseUrl"],
            state_dir=state_dir,
            root={"pinned": pinned},
            sync=SyncOptions(mode="resident", poll_seconds=1, edge_pointer_url=facts["edgePointerUrl"], root_url=facts["rootUrl"]),
            telemetry={"sink": "memory"},
        )
        try:
            assert ap.generation == 1
            rendered = ap.prompt("support.triage").render(ticket="T-1", customer="Ada")
            assert "Triage T-1 from <customer>Ada</customer>" in rendered.text, "the same fencing as production"
            assert rendered.model == "claude-sonnet-5"
            # A save is a generation the runtime follows within a poll.
            with open(os.path.join(prompts, "support", "triage.md"), "w", encoding="utf-8") as f:
                f.write("---\nvariables: ticket!\n---\nTriage {{ticket}} carefully.\n")
            _wait(lambda: ap.generation == 2, "generation 2")
            assert ap.prompt("support.triage").render(ticket="T-2").text == "Triage T-2 carefully."
            # release.json turns unlock_required on: generation 3 is staged and waits for the unlock.
            with open(os.path.join(prompts, "release.json"), "w", encoding="utf-8") as f:
                json.dump({"applyPolicy": "unlock_required"}, f)
            _wait(lambda: ap.status().staged_generation == 3, "generation 3 staged")
            assert ap.generation == 2
            assert ap.status().apply_state == "awaiting_unlock"
            unlocked = ap.unlock()
            assert unlocked is not None and unlocked["generation"] == 3
            assert ap.generation == 3
        finally:
            ap.stop()
    finally:
        server.stop()
        shutil.rmtree(work, ignore_errors=True)
