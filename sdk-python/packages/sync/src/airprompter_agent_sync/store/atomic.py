"""The write-then-rename discipline every sidecar under ``<state_dir>/airprompter/<agentId>/<target>/`` uses: a
temp file, fsync'd, then renamed over the target, so a crash mid-write leaves the old file or the new one, never
half. Pulled out of :mod:`airprompter_agent_sync.store.slot_store` so ``pin.py`` writes ``pin.json`` under the
same rule the store writes ``store.json`` under, without importing that module's private names.

Example::

    write_file_atomically(pin_path, json.dumps(pin, indent=2).encode("utf-8"))
"""

from __future__ import annotations

import os
from typing import Callable, Optional

from airprompter_agent_core._util import fsync_dir


def write_file_synced(path: str, data: bytes, mode: int = 0o600) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)


def write_file_atomically(path: str, data: bytes, before_rename: Optional[Callable[[str], None]] = None, mode: int = 0o600) -> None:
    """Write to a temp file, fsync, rename: the file is either the old one or the new one, never half."""
    temp = f"{path}.{os.urandom(4).hex()}.tmp"
    write_file_synced(temp, data, mode)
    if before_rename:
        before_rename(path)
    os.replace(temp, path)
    fsync_dir(os.path.dirname(path))
