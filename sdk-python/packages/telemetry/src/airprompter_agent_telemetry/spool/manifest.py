"""The telemetry daemon's two files (``protocol/daemon.md``, draft 3): the discovery file the daemon publishes
(``<storeDir>/daemon.json`` — the folder it scans and how it is doing), and the manifest a writer adds beside each
closed segment (``seg-….manifest.json`` — the segment's size, digest and rows, the writer's scope, and its heartbeat
report without ``spool``). Both are written with a temp file and a rename, so a reader never sees half of one.

Example::

    found = read_daemon_discovery(fs, store_dir, agent_id="agt_1", target="prod", organization_id="org_1", now_ms=now)
    spool_dir = found["discovery"]["spoolDir"] if found["live"] else os.path.join(store_dir, "spool", "telemetry")
    write_segment_manifest(fs, spool_dir, "seg-i-7f3a…-29817383-0.ndjson", organization_id="org_1", agent_id="agt_1",
                           target="prod", report=report, closed_at_ms=now)
    manifest = read_segment_manifest(fs, spool_dir, "seg-i-7f3a…-29817383-0.ndjson")   # None | {"ok": True, ...} | {"ok": False, "reason": ...}
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
from typing import Any, Mapping, Optional

from airprompter_agent_core._util import instant, iso_ms
from airprompter_agent_core.ports import FsPort

__all__ = [
    "SPOOL_MANIFEST_FORMAT",
    "DAEMON_DISCOVERY_FORMAT",
    "MANIFEST_GRACE_MS",
    "DAEMON_DISCOVERY_MAX_AGE_MS",
    "DAEMON_DISCOVERY_REFRESH_MS",
    "DAEMON_DISCOVERY_FILE",
    "MANIFEST_SUFFIX",
    "MANIFEST_NAME",
    "manifest_name_of",
    "segment_name_of_manifest",
    "sha256_hex",
    "write_segment_manifest",
    "read_segment_manifest",
    "daemon_discovery_path",
    "read_daemon_discovery",
    "write_daemon_discovery",
    "remove_daemon_discovery",
]

SPOOL_MANIFEST_FORMAT = 1
DAEMON_DISCOVERY_FORMAT = 1
#: A closed segment with no manifest waits this long for its writer to add one before it is uploaded without.
MANIFEST_GRACE_MS = 60 * 1000
#: A discovery file whose ``heartbeatAt`` is older than this names a daemon that is gone.
DAEMON_DISCOVERY_MAX_AGE_MS = 10 * 60 * 1000
#: The daemon refreshes ``heartbeatAt`` at least this often.
DAEMON_DISCOVERY_REFRESH_MS = 60 * 1000
DAEMON_DISCOVERY_FILE = "daemon.json"
MANIFEST_SUFFIX = ".manifest.json"
MANIFEST_NAME = re.compile(r"^seg-([A-Za-z0-9._~-]{8,64})-(\d+)-(\d+)\.manifest\.json$")
_SEGMENT_INSTANCE = re.compile(r"^seg-(.+)-\d+-\d+\.ndjson$")


def manifest_name_of(segment: str) -> str:
    """``seg-….ndjson`` → ``seg-….manifest.json``."""
    return segment[: -len(".ndjson")] + MANIFEST_SUFFIX


def segment_name_of_manifest(manifest: str) -> str:
    """``seg-….manifest.json`` → ``seg-….ndjson``."""
    return manifest[: -len(MANIFEST_SUFFIX)] + ".ndjson"


def sha256_hex(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _replace_file(fs: FsPort, path: str, text: str) -> None:
    """Write a file whole: temp + rename, mode 0600. Raises what the port raises — the callers count it."""
    temp = f"{path}.{secrets.token_hex(4)}.tmp"
    fs.write_file(temp, text.encode("utf-8"), 0o600)
    fs.rename(temp, path)


def _dumps(value: Any, pretty: bool = False) -> str:
    return json.dumps(value, indent=2 if pretty else None, separators=None if pretty else (",", ":"), ensure_ascii=False)


def write_segment_manifest(fs: FsPort, directory: str, segment: str, *, organization_id: str, agent_id: str, target: str, report: Mapping[str, Any], closed_at_ms: float) -> dict[str, Any]:
    """Build and write a closed segment's manifest from the segment's own bytes. Raises on a filesystem failure."""
    data = fs.read_file(os.path.join(directory, segment))
    match = _SEGMENT_INSTANCE.match(segment)
    instance_id = match.group(1) if match else ""
    body = {key: value for key, value in report.items() if key != "spool"}
    body["instanceId"] = instance_id
    manifest = {
        "format": SPOOL_MANIFEST_FORMAT,
        "kind": "segment",
        "segment": segment,
        "bytes": len(data),
        "sha256": sha256_hex(data),
        "rows": data.count(b"\n"),
        "instanceId": instance_id,
        "organizationId": organization_id,
        "agentId": agent_id,
        "target": target,
        "closedAt": iso_ms(closed_at_ms),
        "report": body,
    }
    _replace_file(fs, os.path.join(directory, manifest_name_of(segment)), _dumps(manifest))
    return manifest


def _text(value: Any) -> bool:
    return isinstance(value, str) and len(value) > 0


def _int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def read_segment_manifest(fs: FsPort, directory: str, segment: str) -> Optional[dict[str, Any]]:
    """A segment's manifest: ``None`` when there is none; ``{"ok": False, "reason": …}`` when there is one that cannot be
    trusted (unreadable, another format, the wrong segment or instance) — the daemon quarantines the pair;
    ``{"ok": True, "manifest": …}`` otherwise."""
    path = os.path.join(directory, manifest_name_of(segment))
    if not fs.exists(path):
        return None
    try:
        parsed = json.loads(fs.read_file(path).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {"ok": False, "reason": "manifest_unreadable"}
    if not isinstance(parsed, dict):
        return {"ok": False, "reason": "manifest_unreadable"}
    if parsed.get("format") != SPOOL_MANIFEST_FORMAT or parsed.get("kind") != "segment":
        return {"ok": False, "reason": "manifest_format"}
    if parsed.get("segment") != segment:
        return {"ok": False, "reason": "manifest_names_another_segment"}
    match = _SEGMENT_INSTANCE.match(segment)
    if parsed.get("instanceId") != (match.group(1) if match else None):
        return {"ok": False, "reason": "manifest_instance_mismatch"}
    if not _int(parsed.get("bytes")) or not _text(parsed.get("sha256")) or not _int(parsed.get("rows")):
        return {"ok": False, "reason": "manifest_incomplete"}
    if not all(_text(parsed.get(key)) for key in ("organizationId", "agentId", "target")) or not isinstance(parsed.get("report"), dict):
        return {"ok": False, "reason": "manifest_incomplete"}
    return {"ok": True, "manifest": parsed}


def daemon_discovery_path(store_dir: str) -> str:
    return os.path.join(store_dir, DAEMON_DISCOVERY_FILE)


def read_daemon_discovery(fs: FsPort, store_dir: str, *, agent_id: str, target: str, now_ms: float, organization_id: Optional[str] = None, max_age_ms: Optional[int] = None) -> dict[str, Any]:
    """The daemon's discovery file for this agent and target, and whether it is live: readable, format 1, this scope,
    and ``heartbeatAt`` within ``max_age_ms`` (10 minutes). Anything else is ignored — never trusted in part.

    ``{"live": True, "discovery": …}`` or ``{"live": False, "reason": "absent" | "unreadable" | "format" | "scope" | "stale", "discovery": … | None}``.
    """
    path = daemon_discovery_path(store_dir)
    try:
        exists = fs.exists(path)
    except OSError:
        exists = False
    if not exists:
        return {"live": False, "reason": "absent", "discovery": None}
    try:
        parsed = json.loads(fs.read_file(path).decode("utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return {"live": False, "reason": "unreadable", "discovery": None}
    if not isinstance(parsed, dict) or parsed.get("format") != DAEMON_DISCOVERY_FORMAT or parsed.get("kind") != "daemon" or not _text(parsed.get("spoolDir")) or not _text(parsed.get("heartbeatAt")):
        return {"live": False, "reason": "format", "discovery": None}
    if parsed.get("agentId") != agent_id or parsed.get("target") != target or (organization_id and parsed.get("organizationId") and parsed.get("organizationId") != organization_id):
        return {"live": False, "reason": "scope", "discovery": parsed}
    try:
        age = now_ms - instant(parsed["heartbeatAt"])
    except (ValueError, TypeError):
        return {"live": False, "reason": "stale", "discovery": parsed}
    if age > (DAEMON_DISCOVERY_MAX_AGE_MS if max_age_ms is None else max_age_ms):
        return {"live": False, "reason": "stale", "discovery": parsed}
    return {"live": True, "discovery": parsed}


def write_daemon_discovery(fs: FsPort, store_dir: str, discovery: Mapping[str, Any]) -> None:
    """Publish (or refresh) the discovery file: temp + rename, mode 0600. Raises what the port raises."""
    fs.mkdirp(store_dir, 0o700)
    _replace_file(fs, daemon_discovery_path(store_dir), _dumps(dict(discovery), pretty=True))


def remove_daemon_discovery(fs: FsPort, store_dir: str, pid: Optional[int] = None) -> None:
    """A clean stop removes the file; a crash leaves it to go stale. Never raises."""
    try:
        path = daemon_discovery_path(store_dir)
        if not fs.exists(path):
            return
        # Another daemon took over the file since: it is not ours to remove.
        if pid is not None and json.loads(fs.read_file(path).decode("utf-8")).get("pid") != pid:
            return
        fs.unlink(path)
    except (OSError, ValueError, UnicodeDecodeError, AttributeError):
        pass
