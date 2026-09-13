"""Daemon-attached mode against a fake ``airprompterd`` speaking
``protocol/daemon-socket.md`` over a Unix socket: hello with a scope check,
the slot fetched over the socket (no store files touched by this process),
a ``generation`` event refreshing the release and firing ``on_change``,
unlock / rollback / sync forwarded host-wide, the heartbeat left to the
daemon, and an absent socket falling back to in-process sync.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time

import pytest

from airprompter_agent._util import b64url_encode
from airprompter_agent.agent import AirPrompterAgent, SyncOptions
from airprompter_agent.protocol.trust import public_jwk_of
from airprompter_agent.sync.daemon import DaemonClient, DaemonError, daemon_socket_path

from .control_plane import FakeControlPlane

SCOPE = {"organizationId": "org_1", "agentId": "agt_1", "target": "prod"}
KW = {"organization_id": "org_1", "agent_id": "agt_1", "target": "prod"}

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="Unix sockets only in this phase")


class FakeDaemon:
    """One connection at a time is enough for an SDK test; every op the protocol names is answered."""

    def __init__(self, path: str, plane: FakeControlPlane, agent_id: str = "agt_1", target: str = "prod"):
        self.path = path
        self.plane = plane
        self.agent_id = agent_id
        self.target = target
        self.generation = plane.manifest["payload"]["generation"] if plane.manifest else 0
        self.staged_generation = None
        #: S4: the host's apply policy as the daemon's store holds it; ``policy`` rewrites it and broadcasts.
        self.apply_policy = {"effective": "auto", "source": "pinned", "manifestSaid": "auto"}
        self.ops: list[str] = []
        self._connections: list[socket.socket] = []
        self._server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._server.bind(path)
        os.chmod(path, 0o600)
        self._server.listen(4)
        self._stopping = False
        threading.Thread(target=self._accept_loop, daemon=True).start()

    def _accept_loop(self) -> None:
        while not self._stopping:
            try:
                conn, _ = self._server.accept()
            except OSError:
                return
            self._connections.append(conn)
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _slot(self) -> dict:
        manifest = self.plane.manifest
        return {"slot": "A", "generation": self.generation, "signingKeyId": manifest["signatures"][0]["keyId"], "manifest": manifest, "payloads": [{"contentHash": h, "bytes": b64url_encode(b)} for h, b in self.plane.payloads.items()], "applyPolicy": self.apply_policy}

    def _serve(self, conn: socket.socket) -> None:
        buffer = b""
        while True:
            try:
                chunk = conn.recv(65536)
            except OSError:
                return
            if not chunk:
                return
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                message = json.loads(line)
                op = message["op"]
                self.ops.append(op)
                if op == "hello":
                    reply = {"daemon": "fake/0", "protocol": "0.2.5", "agentId": self.agent_id, "target": self.target, "instanceId": "i-daemon", "generation": self.generation, "stagedGeneration": self.staged_generation}
                elif op == "slot":
                    reply = self._slot()
                elif op == "sync":
                    reply = {"outcome": "unchanged"}
                elif op == "unlock":
                    if self.staged_generation is None:
                        reply = {"generation": None}
                    else:
                        self.generation, self.staged_generation = self.staged_generation, None
                        reply = {"generation": self.generation}
                elif op == "rollback":
                    self.generation -= 1
                    reply = {"generation": self.generation, "forced": True}
                elif op == "policy":
                    self.apply_policy = {"effective": message["value"], "source": "operator", "manifestSaid": self.apply_policy["manifestSaid"]}
                    self.last_policy_by = message.get("by")
                    reply = {"applyPolicy": self.apply_policy}
                    self.emit({"event": "policy", "applyPolicy": self.apply_policy})
                else:
                    conn.sendall((json.dumps({"id": message["id"], "ok": False, "error": "unknown_op"}) + "\n").encode("utf-8"))
                    continue
                conn.sendall((json.dumps({"id": message["id"], "ok": True, **reply}) + "\n").encode("utf-8"))

    def emit(self, event: dict) -> None:
        for conn in list(self._connections):
            try:
                conn.sendall((json.dumps(event) + "\n").encode("utf-8"))
            except OSError:
                pass

    def stop(self) -> None:
        self._stopping = True
        for conn in self._connections:
            try:
                conn.close()
            except OSError:
                pass
        self._server.close()
        try:
            os.remove(self.path)
        except FileNotFoundError:
            pass


@pytest.fixture
def state_dir():
    path = tempfile.mkdtemp(prefix="apd-")
    yield path
    shutil.rmtree(path, ignore_errors=True)


def _wait(predicate, seconds=2.0):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def test_daemon_attach_events_and_forwarded_ops(state_dir):
    plane = FakeControlPlane(SCOPE)
    plane.promote([plane.slot(tag="support.reply", text="Reply v1 to {{name}}.", variables=[{"name": "name", "required": False, "trust": "operator"}])])
    socket_path = daemon_socket_path(state_dir=state_dir, agent_id="agt_1", target="prod")
    os.makedirs(os.path.dirname(socket_path), mode=0o700, exist_ok=True)
    daemon = FakeDaemon(socket_path, plane)
    try:
        changes = []
        ap = AirPrompterAgent.start(**KW, state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, sync=SyncOptions(mode="daemon"))
        ap.on_change(changes.append)
        assert ap.status().source == "daemon" and ap.status().daemon == {"attached": True, "socket_path": socket_path}
        assert ap.status().storage_protection == "daemon"
        assert ap.generation == 1
        assert ap.prompt("support.reply").render(name="Ann").text == "Reply v1 to Ann."
        assert not os.path.exists(os.path.join(state_dir, "airprompter", "agt_1", "prod", "store.json")), "a daemon-attached process never touches store files"
        assert ap.heartbeat_body()["storageProtection"] == "custom"
        ap.heartbeat_now()  # no client in daemon mode: the daemon reports for the host
        assert not plane.heartbeats

        plane.promote([plane.slot(tag="support.reply", text="Reply v2 to {{name}}.", variables=[{"name": "name", "required": False, "trust": "operator"}])])
        daemon.generation = 2
        daemon.emit({"event": "generation", "generation": 2, "stagedGeneration": None})
        assert _wait(lambda: ap.generation == 2), "the generation event refreshed the slot"
        assert ap.prompt("support.reply").render(name="Ann").text == "Reply v2 to Ann."
        assert changes and changes[-1].generation == 2

        daemon.staged_generation = 3
        daemon.emit({"event": "generation", "generation": 2, "stagedGeneration": 3})
        assert _wait(lambda: ap.status().staged_generation == 3)
        assert ap.status().apply_state == "awaiting_unlock"
        plane.promote([plane.slot(tag="support.reply", text="Reply v3 to {{name}}.", variables=[{"name": "name", "required": False, "trust": "operator"}])])
        assert ap.unlock() == {"generation": 3}
        assert ap.generation == 3, "unlock is forwarded to the host daemon and the slot re-read"
        assert ap.rollback() == {"generation": 2, "forced": True}
        ap.sync_now()
        assert "sync" in daemon.ops and "unlock" in daemon.ops and "rollback" in daemon.ops
        # S4: the host's policy is the daemon's; the slot answer carried it, and the operator's act through the socket updates it.
        assert ap.status().apply_policy == {"effective": "auto", "source": "pinned", "manifestSaid": "auto"}
        assert ap.heartbeat_body()["applyPolicy"] == {"effective": "auto", "source": "pinned"}
        assert ap.set_apply_policy("unlock_required", by="seth") == {"effective": "unlock_required", "source": "operator", "manifestSaid": "auto"}
        assert daemon.last_policy_by == "seth"
        assert "policy" in daemon.ops
        assert _wait(lambda: ap.status().apply_policy["source"] == "operator")
        ap.stop()
    finally:
        daemon.stop()


def test_daemon_scope_mismatch_and_absent_socket(state_dir):
    plane = FakeControlPlane(SCOPE)
    plane.promote([plane.slot(tag="support.reply", text="Reply.")])
    socket_path = os.path.join(state_dir, "other.sock")
    daemon = FakeDaemon(socket_path, plane, agent_id="agt_other")
    try:
        with pytest.raises(DaemonError) as mismatch:
            DaemonClient.connect(socket_path=socket_path, agent_id="agt_1", target="prod", sdk="t/0")
        assert mismatch.value.code == "scope_mismatch"
    finally:
        daemon.stop()
    assert DaemonClient.connect(socket_path=os.path.join(state_dir, "missing.sock"), agent_id="agt_1", target="prod", sdk="t/0") is None
    # No daemon on the host: daemon mode falls back to in-process sync from this process's own store.
    events = []
    ap = AirPrompterAgent.start(**KW, api_key=plane.api_key, base_url="https://api.test", state_dir=state_dir, root={"pinned": public_jwk_of(plane.root_key)}, sync=SyncOptions(mode="daemon", root_url="https://edge.test/roots/prod/root.json", poll_seconds=3600), transport=plane.transport(), logger=lambda e: events.append(e["event"]))
    assert "daemon_absent" in events
    assert ap.status().source == "store" and ap.status().daemon is None
    assert ap.generation == 1
    ap.stop()
