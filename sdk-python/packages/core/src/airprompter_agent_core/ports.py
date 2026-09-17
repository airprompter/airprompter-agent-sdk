"""Ports (S2, AIR-1970): the seams between the SDK and the world it cannot control.

The filesystem, the clock and the network are reached through these so a fake can
*fill* (ENOSPC), *fail* (EIO), *lose a file* (ENOENT) or *skew* — our own rule:
a forgiving fake hides every budget bug. ``OsFs`` is the real filesystem;
``airprompter_agent_core.testing.MemoryFs`` is the fake. Every method raises an
``OSError`` whose ``errno`` names the failure; the *caller* decides what a failure
means (the spool counts and carries on; the store refuses).

Example::

    fs = fs_or_default(None)           # OS_FS; a test passes airprompter_agent_core.testing.MemoryFs()
    try:
        fd = fs.open(path, "a")        # append, create, 0600
        fs.write(fd, line)
        fs.fsync(fd)
        fs.close(fd)
    except OSError as error:
        code = fs_failure_code(error)  # "ENOSPC", "EIO", "ENOENT" …: the caller decides what it means
"""

from __future__ import annotations

import errno
import os
import time
from typing import Optional, Protocol


class FsPort(Protocol):
    def mkdirp(self, path: str, mode: int = 0o700) -> None: ...
    def exists(self, path: str) -> bool: ...
    def list(self, directory: str) -> list[str]: ...
    def list_recursive(self, directory: str) -> list[str]: ...
    def stat(self, path: str) -> tuple[int, float]:
        """``(size, mtime_ms)``."""
        ...
    def open(self, path: str, flags: str, mode: int = 0o600) -> int:
        """``flags`` is ``"a"`` (append, create), ``"r"`` or ``"r+"``; returns a handle."""
        ...
    def write(self, fd: int, data: bytes) -> None: ...
    def fsync(self, fd: int) -> None: ...
    def close(self, fd: int) -> None: ...
    def rename(self, src: str, dst: str) -> None: ...
    def unlink(self, path: str) -> None: ...
    def read_file(self, path: str) -> bytes: ...
    def write_file(self, path: str, data: bytes, mode: int = 0o600) -> None: ...
    def rm(self, path: str, recursive: bool = False, force: bool = False) -> None: ...


class ClockPort(Protocol):
    def now_ms(self) -> float: ...


def fs_failure_code(error: BaseException) -> str:
    """The failure's name (``ENOSPC``, ``EIO``, ``ENOENT`` …) or ``unknown``."""
    number = getattr(error, "errno", None)
    if isinstance(number, int) and number in errno.errorcode:
        return errno.errorcode[number]
    return "unknown"


class OsFs:
    """The real filesystem behind the port: one ``os`` call per method."""

    def mkdirp(self, path: str, mode: int = 0o700) -> None:
        os.makedirs(path, mode=mode, exist_ok=True)

    def exists(self, path: str) -> bool:
        return os.path.exists(path)

    def list(self, directory: str) -> list[str]:
        return os.listdir(directory) if os.path.isdir(directory) else []

    def list_recursive(self, directory: str) -> list[str]:
        if not os.path.isdir(directory):
            return []
        out: list[str] = []
        for root, _dirs, files in os.walk(directory):
            for name in files:
                out.append(os.path.relpath(os.path.join(root, name), directory))
        return sorted(out)

    def stat(self, path: str) -> tuple[int, float]:
        result = os.stat(path)
        return result.st_size, result.st_mtime * 1000.0

    def open(self, path: str, flags: str, mode: int = 0o600) -> int:
        if flags == "a":
            return os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, mode)
        if flags == "r+":
            return os.open(path, os.O_RDWR)
        return os.open(path, os.O_RDONLY)

    def write(self, fd: int, data: bytes) -> None:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]

    def fsync(self, fd: int) -> None:
        os.fsync(fd)

    def close(self, fd: int) -> None:
        os.close(fd)

    def rename(self, src: str, dst: str) -> None:
        os.replace(src, dst)

    def unlink(self, path: str) -> None:
        os.remove(path)

    def read_file(self, path: str) -> bytes:
        with open(path, "rb") as handle:
            return handle.read()

    def write_file(self, path: str, data: bytes, mode: int = 0o600) -> None:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        try:
            self.write(fd, data)
        finally:
            os.close(fd)

    def rm(self, path: str, recursive: bool = False, force: bool = False) -> None:
        if os.path.isdir(path) and not os.path.islink(path):
            if not recursive:
                raise IsADirectoryError(errno.EISDIR, "is a directory", path)
            import shutil

            shutil.rmtree(path, ignore_errors=force)
            return
        try:
            os.remove(path)
        except FileNotFoundError:
            if not force:
                raise


class SystemClock:
    def now_ms(self) -> float:
        return time.time() * 1000.0


OS_FS = OsFs()
SYSTEM_CLOCK = SystemClock()


def fs_or_default(fs: Optional[FsPort]) -> FsPort:
    return OS_FS if fs is None else fs
