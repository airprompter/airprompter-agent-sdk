"""The SDK's side of ``protocol/daemon-socket.md``: connect to the host's
``airprompterd``, ``hello``, fetch the active slot, listen for ``generation``
events, forward unlock / rollback / sync. Absent socket → ``None``, and the
runtime syncs in-process instead.

Unix domain sockets only in this phase: on Windows the named pipe the
daemon listens on is reported absent and the runtime runs in-process (the
TypeScript SDK attaches there; Python follows one phase behind).
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
import sys
import tempfile
import threading
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional

from .._util import b64url_decode
from ..store.slot_store import LoadedSlot, SlotStore

DAEMON_MAX_LINE_BYTES = 16 * 1024 * 1024
#: Unix socket paths are capped (104 bytes on macOS, 108 on Linux); longer store paths use the per-user runtime directory.
UNIX_SOCKET_PATH_MAX = 100


@dataclass
class DaemonHello:
    daemon: str
    protocol: str
    agent_id: str
    target: str
    instance_id: str
    generation: int
    staged_generation: Optional[int]


class DaemonError(Exception):
    def __init__(self, code: str, message: str):  # "absent" | "not_owner" | "scope_mismatch" | "refused" | "protocol" | "closed"
        super().__init__(message)
        self.code = code


def daemon_socket_path(*, state_dir: str, agent_id: str, target: str) -> str:
    """Where the daemon for this store listens (see daemon-socket.md)."""
    store_dir = SlotStore.path(state_dir=state_dir, agent_id=agent_id, target=target)
    digest = hashlib.sha256(store_dir.encode("utf-8")).hexdigest()[:16]
    if sys.platform == "win32":
        return f"\\\\.\\pipe\\airprompter-{digest}"
    in_store = os.path.join(store_dir, "daemon.sock")
    if len(in_store.encode("utf-8")) <= UNIX_SOCKET_PATH_MAX:
        return in_store
    # $XDG_RUNTIME_DIR and macOS $TMPDIR are per-user 0700 directories; a shared /tmp is the last resort.
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR") or os.environ.get("TMPDIR") or tempfile.gettempdir()
    return os.path.join(runtime_dir, f"airprompter-{digest}.sock")


class DaemonClient:
    #: S3: the lease the daemon reported on its last ``slot`` answer (``leaseExpiresAt``), or None.
    last_lease_expires_at: Optional[str] = None
    #: S4: the apply policy the daemon reported on its last ``slot`` answer (``applyPolicy``), or None.
    last_apply_policy: Optional[dict[str, Any]] = None

    def __init__(self, sock: socket.socket, hello: DaemonHello):
        self._socket = sock
        self.hello = hello
        self._pending: dict[str, tuple[threading.Event, list[Any]]] = {}
        self._next_id = 1
        self._closed = False
        self._lock = threading.Lock()
        self._listeners: list[Callable[[dict[str, Any]], None]] = []
        self._close_listeners: list[Callable[[], None]] = []
        self._reader: Optional[threading.Thread] = None

    @classmethod
    def connect(cls, *, socket_path: str, agent_id: str, target: str, sdk: str, timeout_seconds: float = 2.0) -> Optional["DaemonClient"]:
        """Connects and says hello. ``None`` when there is no daemon (absent socket, refused connection, Windows); raises only for a daemon that answers wrongly."""
        if sys.platform == "win32":
            return None
        if not os.path.exists(socket_path):
            return None
        # A socket another user could have planted is not ours to trust.
        owner = os.stat(socket_path).st_uid
        if hasattr(os, "getuid") and owner != os.getuid():
            raise DaemonError("not_owner", f"{socket_path} is owned by uid {owner}, not this process")
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(timeout_seconds)
        try:
            sock.connect(socket_path)
        except OSError:
            sock.close()
            return None
        sock.settimeout(None)
        client = cls(sock, DaemonHello("", "", agent_id, target, "", 0, None))
        client._attach()
        try:
            hello = client.request("hello", {"sdk": sdk}, timeout_seconds=timeout_seconds)
        except DaemonError:
            client.close()
            raise
        except Exception as error:  # noqa: BLE001
            client.close()
            raise DaemonError("protocol", str(error)) from error
        if hello.get("agentId") != agent_id or hello.get("target") != target:
            client.close()
            raise DaemonError("scope_mismatch", f"daemon serves {hello.get('agentId')}/{hello.get('target')}, this runtime is {agent_id}/{target}")
        client.hello = DaemonHello(str(hello.get("daemon", "")), str(hello.get("protocol", "")), agent_id, target, str(hello.get("instanceId", "")), int(hello.get("generation", 0)), hello.get("stagedGeneration"))
        return client

    def _attach(self) -> None:
        self._reader = threading.Thread(target=self._read_loop, name="airprompter-daemon-reader", daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        buffer = b""
        try:
            while True:
                chunk = self._socket.recv(65536)
                if not chunk:
                    self._fail(DaemonError("closed", "daemon closed the connection"))
                    return
                buffer += chunk
                if len(buffer) > DAEMON_MAX_LINE_BYTES:
                    self._fail(DaemonError("protocol", "line too long"))
                    return
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if line.strip():
                        self._handle_line(line)
        except OSError as error:
            self._fail(DaemonError("closed", str(error)))

    def _handle_line(self, line: bytes) -> None:
        try:
            message = json.loads(line.decode("utf-8"))
        except ValueError:
            self._fail(DaemonError("protocol", "daemon sent a line that is not JSON"))
            return
        if not isinstance(message, dict):
            self._fail(DaemonError("protocol", "daemon sent a line that is not a JSON object"))
            return
        if isinstance(message.get("id"), str):
            with self._lock:
                pending = self._pending.pop(message["id"], None)
            if pending:
                pending[1].append(message)
                pending[0].set()
            return
        if isinstance(message.get("event"), str):
            # Off the reader thread: a listener that asks the daemon something (the SDK re-reads the slot on
            # `generation`) needs the reader free to deliver the answer.
            listeners = list(self._listeners)
            threading.Thread(target=lambda: [listener(message) for listener in listeners], name="airprompter-daemon-event", daemon=True).start()

    def _fail(self, error: DaemonError) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            pending = list(self._pending.values())
            self._pending.clear()
        for event, box in pending:
            box.append(error)
            event.set()
        try:
            self._socket.close()
        except OSError:
            pass
        for listener in list(self._close_listeners):
            listener()

    def request(self, op: str, params: Optional[dict[str, Any]] = None, timeout_seconds: float = 30.0) -> dict[str, Any]:
        with self._lock:
            if self._closed:
                raise DaemonError("closed", "daemon connection is closed")
            request_id = str(self._next_id)
            self._next_id += 1
            event = threading.Event()
            box: list[Any] = []
            self._pending[request_id] = (event, box)
        line = json.dumps({"id": request_id, "op": op, **(params or {})}) + "\n"
        try:
            self._socket.sendall(line.encode("utf-8"))
        except OSError as error:
            self._fail(DaemonError("closed", str(error)))
            raise DaemonError("closed", str(error)) from error
        if not event.wait(timeout_seconds):
            with self._lock:
                self._pending.pop(request_id, None)
            raise DaemonError("protocol", f"daemon did not answer {op} within {timeout_seconds:g}s")
        answer = box[0]
        if isinstance(answer, DaemonError):
            raise answer
        if answer.get("ok") is True:
            return answer
        raise DaemonError("refused", str(answer.get("error") or "refused"))

    def slot(self) -> LoadedSlot:
        response = self.request("slot")
        # S3: the daemon's lease rides the slot answer; an older daemon says nothing and the SDK keeps what it had.
        lease = response.get("leaseExpiresAt")
        self.last_lease_expires_at = lease if isinstance(lease, str) else None
        policy = response.get("applyPolicy")
        self.last_apply_policy = dict(policy) if isinstance(policy, Mapping) and policy.get("effective") in ("auto", "unlock_required") else None
        return LoadedSlot(response["slot"], response["manifest"], int(response["generation"]), str(response.get("signingKeyId", "")), {entry["contentHash"]: b64url_decode(entry["bytes"]) for entry in response.get("payloads", [])})

    def on_event(self, listener: Callable[[dict[str, Any]], None]) -> Callable[[], None]:
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener) if listener in self._listeners else None

    def on_close(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._close_listeners.append(listener)
        return lambda: self._close_listeners.remove(listener) if listener in self._close_listeners else None

    @property
    def is_closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        try:
            self._socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self._socket.close()
        except OSError:
            pass
