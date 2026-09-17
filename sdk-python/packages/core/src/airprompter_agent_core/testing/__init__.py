"""The testing kit (S2, AIR-1970): a filesystem that fills, fails and loses files, and a clock a test moves by hand.

What our own tests run over, and what a customer's CI can import to prove the same things about their host.
Nothing here is loaded by the runtime.

Example::

    fs = MemoryFs(capacity_bytes=4096)   # full at 4 KiB: the next write raises OSError(ENOSPC)
    fs.fail_next("fsync", "EIO")         # the next fsync fails, once
    clock = FakeClock(0)
    sink = DirectorySink("/spool", "i-testinstance", fs=fs)   # airprompter_agent_telemetry, over the fake
    clock.advance(60_000)                # the minute turns; nothing waits on wall time
"""

from __future__ import annotations

import errno
import re
from typing import Optional

from ..ports import ClockPort, FsPort

__all__ = ["MemoryFs", "FakeClock", "ClockPort", "FsPort"]


def _failure(code: str, path: str) -> OSError:
    number = getattr(errno, code, errno.EIO)
    return OSError(number, f"{code}: {path}", path)


def _normalize(path: str) -> str:
    """POSIX keys whatever the host's separator: ``os.path.join`` on Windows hands the sink backslashes; a drive letter is dropped."""
    parts: list[str] = []
    for part in re.split(r"[\\/]+", re.sub(r"^[A-Za-z]:", "", path)):
        if part in ("", "."):
            continue
        if part == "..":
            if parts:
                parts.pop()
        else:
            parts.append(part)
    return "/" + "/".join(parts)


def _parent(path: str) -> str:
    i = path.rfind("/")
    return "/" if i <= 0 else path[:i]


class MemoryFs:
    """An in-memory ``FsPort``: ``capacity_bytes`` fills it, ``fail_next`` fails an operation, ``vanish`` loses a file."""

    def __init__(self, capacity_bytes: float = float("inf")):
        self.capacity_bytes = capacity_bytes
        self.clock_ms = 0.0
        self._files: dict[str, tuple[bytearray, int, float]] = {}
        self._dirs: set[str] = {"/"}
        self._handles: dict[int, tuple[str, str]] = {}
        self._next_fd = 3
        self._pending: dict[str, tuple[str, int]] = {}
        self.journal: list[tuple[str, str]] = []

    def fail_next(self, op: str, code: str, times: int = 1) -> None:
        self._pending[op] = (code, times)

    def vanish(self, path: str) -> None:
        self._files.pop(_normalize(path), None)

    def bytes_used(self) -> int:
        return sum(len(data) for data, _mode, _mtime in self._files.values())

    def tree(self) -> list[tuple[str, int]]:
        return sorted((path, len(data)) for path, (data, _mode, _mtime) in self._files.items())

    def _gate(self, op: str, path: str) -> None:
        self.journal.append((op, path))
        pending = self._pending.get(op)
        if pending is None:
            return
        code, times = pending
        if times <= 1:
            del self._pending[op]
        else:
            self._pending[op] = (code, times - 1)
        raise _failure(code, path)

    def _ensure_capacity(self, extra: int, path: str) -> None:
        if self.bytes_used() + extra > self.capacity_bytes:
            raise _failure("ENOSPC", path)

    def mkdirp(self, path: str, mode: int = 0o700) -> None:
        p = _normalize(path)
        self._gate("mkdirp", p)
        current = ""
        for part in p.split("/"):
            if not part:
                continue
            current += f"/{part}"
            if current in self._files:
                raise _failure("EEXIST", current)
            self._dirs.add(current)

    def exists(self, path: str) -> bool:
        p = _normalize(path)
        self._gate("exists", p)
        return p in self._files or p in self._dirs

    def list(self, directory: str) -> list[str]:
        d = _normalize(directory)
        self._gate("list", d)
        if d not in self._dirs:
            return []
        prefix = "/" if d == "/" else f"{d}/"
        names = set()
        for path in list(self._files) + list(self._dirs):
            if path != d and path.startswith(prefix):
                names.add(path[len(prefix):].split("/")[0])
        return sorted(names)

    def list_recursive(self, directory: str) -> list[str]:
        d = _normalize(directory)
        self._gate("list_recursive", d)
        if d not in self._dirs:
            return []
        prefix = "/" if d == "/" else f"{d}/"
        return sorted(path[len(prefix):] for path in self._files if path.startswith(prefix))

    def stat(self, path: str) -> tuple[int, float]:
        p = _normalize(path)
        self._gate("stat", p)
        if p in self._files:
            data, _mode, mtime = self._files[p]
            return len(data), mtime
        if p in self._dirs:
            return 0, 0.0
        raise _failure("ENOENT", p)

    def open(self, path: str, flags: str, mode: int = 0o600) -> int:
        p = _normalize(path)
        self._gate("open", p)
        if _parent(p) not in self._dirs:
            raise _failure("ENOENT", p)
        if p not in self._files:
            if flags in ("r", "r+"):
                raise _failure("ENOENT", p)
            self._files[p] = (bytearray(), mode, self.clock_ms)
        fd = self._next_fd
        self._next_fd += 1
        self._handles[fd] = (p, flags)
        return fd

    def write(self, fd: int, data: bytes) -> None:
        handle = self._handles.get(fd)
        self._gate("write", handle[0] if handle else f"fd:{fd}")
        if handle is None:
            raise _failure("EBADF", f"fd:{fd}")
        path = handle[0]
        if path not in self._files:
            raise _failure("ENOENT", path)
        self._ensure_capacity(len(data), path)
        buffer, mode, _mtime = self._files[path]
        buffer.extend(data)
        self._files[path] = (buffer, mode, self.clock_ms)

    def fsync(self, fd: int) -> None:
        handle = self._handles.get(fd)
        self._gate("fsync", handle[0] if handle else f"fd:{fd}")
        if handle is None:
            raise _failure("EBADF", f"fd:{fd}")

    def close(self, fd: int) -> None:
        handle = self._handles.get(fd)
        self._gate("close", handle[0] if handle else f"fd:{fd}")
        if handle is None:
            raise _failure("EBADF", f"fd:{fd}")
        del self._handles[fd]

    def rename(self, src: str, dst: str) -> None:
        f = _normalize(src)
        t = _normalize(dst)
        self._gate("rename", f)
        if f not in self._files:
            raise _failure("ENOENT", f)
        if _parent(t) not in self._dirs:
            raise _failure("ENOENT", t)
        self._files[t] = self._files.pop(f)
        for fd, (path, flags) in list(self._handles.items()):
            if path == f:
                self._handles[fd] = (t, flags)

    def unlink(self, path: str) -> None:
        p = _normalize(path)
        self._gate("unlink", p)
        if self._files.pop(p, None) is None:
            raise _failure("ENOENT", p)

    def read_file(self, path: str) -> bytes:
        p = _normalize(path)
        self._gate("read_file", p)
        if p not in self._files:
            raise _failure("ENOENT", p)
        return bytes(self._files[p][0])

    def write_file(self, path: str, data: bytes, mode: int = 0o600) -> None:
        p = _normalize(path)
        self._gate("write_file", p)
        if _parent(p) not in self._dirs:
            raise _failure("ENOENT", p)
        existing = len(self._files[p][0]) if p in self._files else 0
        self._ensure_capacity(len(data) - existing, p)
        self._files[p] = (bytearray(data), mode, self.clock_ms)

    def rm(self, path: str, recursive: bool = False, force: bool = False) -> None:
        p = _normalize(path)
        self._gate("rm", p)
        if self._files.pop(p, None) is not None:
            return
        if p in self._dirs:
            if not recursive:
                raise _failure("EISDIR", p)
            prefix = f"{p}/"
            for key in list(self._files):
                if key.startswith(prefix):
                    del self._files[key]
            for d in list(self._dirs):
                if d == p or d.startswith(prefix):
                    self._dirs.discard(d)
            return
        if not force:
            raise _failure("ENOENT", p)


class FakeClock:
    """A clock a test moves by hand: ``advance(ms)``, ``set(ms)``, or ``skew(ms)`` for a host whose clock is off."""

    def __init__(self, current_ms: Optional[float] = None):
        self._current_ms = 1_789_300_800_000.0 if current_ms is None else current_ms  # 2026-09-13T12:00:00Z
        self._offset_ms = 0.0

    def now_ms(self) -> float:
        return self._current_ms + self._offset_ms

    def advance(self, ms: float) -> None:
        self._current_ms += ms

    def set(self, ms: float) -> None:
        self._current_ms = ms

    def skew(self, ms: float) -> None:
        self._offset_ms = ms
