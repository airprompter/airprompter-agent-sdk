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
    """Poll ``check`` until it holds or the deadline passes; ``label`` may be a callable, read only on a timeout."""
    deadline = time.monotonic() + timeout
    while not check():
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {label() if callable(label) else label}")
        time.sleep(0.05)


class DevServer:
    """``airprompter dev`` with its event log (stderr, one JSON line each) in a file: read on a failure, and never a pipe
    nobody drains."""

    def __init__(self, directory: str, log_path: str):
        self.directory = directory
        self.log_path = log_path
        self._log = open(log_path, "w", encoding="utf-8")
        self.process = subprocess.Popen(["node", "--import", "tsx", CLI_MAIN, "dev", directory, "--port", "0", "--json"], cwd=TS_DIR, stdout=subprocess.PIPE, stderr=self._log, text=True)
        line = self.process.stdout.readline()
        if not line:
            self.stop()
            raise AssertionError(f"airprompter dev did not start: {self.log()}")
        try:
            self.facts = json.loads(line)
        except ValueError:
            self.stop()
            raise AssertionError(f"airprompter dev printed no facts line: {line!r} (dev: {self.log()})") from None

    def log(self) -> str:
        with open(self.log_path, encoding="utf-8") as f:
            return " | ".join(line.strip() for line in f if line.strip())

    def promoted(self) -> int:
        """The generation the server has promoted: the counter it writes after each promotion, before it logs it."""
        try:
            with open(os.path.join(self.directory, ".airprompter-dev", "generation"), encoding="utf-8") as f:
                return int(f.read().strip() or 0)
        except (OSError, ValueError):
            return 0

    def stop(self) -> None:
        """SIGTERM, then SIGKILL if it has not exited within 10 s; the pipe and the log are closed either way."""
        try:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=10)
        finally:
            self.process.stdout.close()
            self._log.close()


@pytest.mark.skipif(not _node_available(), reason="node + sdk-typescript/node_modules (npm ci) needed to run airprompter dev from source")
def test_python_sdk_syncs_from_airprompter_dev_and_honours_unlock_required_locally():
    work = tempfile.mkdtemp(prefix="ap-dev-py-")
    prompts = os.path.join(work, "prompts")
    os.makedirs(os.path.join(prompts, "support"))
    with open(os.path.join(prompts, "support", "triage.md"), "w", encoding="utf-8") as f:
        f.write("---\nmodel: claude-sonnet-5\nvariables: ticket!, customer?\n---\nTriage {{ticket}} from {{customer}}.\n")
    server = DevServer(prompts, os.path.join(work, "dev.log"))
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
            root={"pinned": pinned, "hosted_environment": "dev"},  # the local registry's root is scoped to its --environment
            sync=SyncOptions(mode="resident", poll_seconds=1, edge_pointer_url=facts["edgePointerUrl"], root_url=facts["rootUrl"]),
            telemetry={"sink": "memory"},
        )
        try:
            assert ap.generation == 1
            rendered = ap.prompt("support.triage").render(ticket="T-1", customer="Ada")
            assert "Triage T-1 from <customer>Ada</customer>" in rendered.text, "the same fencing as production"
            assert rendered.model == "claude-sonnet-5"
            # A save is a generation the runtime follows within a poll. Two steps, each waited on as state: the server sees
            # the save through fs.watch (AIR-2268) and promotes it, then the runtime's next poll picks it up.
            with open(os.path.join(prompts, "support", "triage.md"), "w", encoding="utf-8") as f:
                f.write("---\nvariables: ticket!\n---\nTriage {{ticket}} carefully.\n")
            _wait(lambda: server.promoted() >= 2, lambda: f"the server to promote generation 2 (dev: {server.log()})")
            assert server.promoted() == 2, f"one save, one generation: the server promoted past generation 2 (dev: {server.log()})"
            # `>=`: a runtime that went past 2 is checked against the server first, so a double promotion is named as the
            # server's fault, not as a runtime that never arrived.
            _wait(lambda: ap.generation >= 2, lambda: f"the runtime on generation 2 (status: {ap.status()}; dev: {server.log()})")
            assert server.promoted() == 2, f"one save, one generation: the server promoted past generation 2 (dev: {server.log()})"
            assert ap.generation == 2, f"the runtime past generation 2 the server never promoted (status: {ap.status()})"
            assert ap.prompt("support.triage").render(ticket="T-2").text == "Triage T-2 carefully."
            # release.json turns unlock_required on: generation 3 is staged and waits for the unlock.
            with open(os.path.join(prompts, "release.json"), "w", encoding="utf-8") as f:
                json.dump({"applyPolicy": "unlock_required"}, f)
            _wait(lambda: server.promoted() >= 3, lambda: f"the server to promote generation 3 (dev: {server.log()})")
            assert server.promoted() == 3, f"one save, one generation: the server promoted past generation 3 (dev: {server.log()})"
            _wait(lambda: (ap.status().staged_generation or 0) >= 3, lambda: f"generation 3 staged (status: {ap.status()}; dev: {server.log()})")
            assert server.promoted() == 3, f"one save, one generation: the server promoted past generation 3 (dev: {server.log()})"
            assert ap.status().staged_generation == 3, f"staged past generation 3 (status: {ap.status()})"
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
