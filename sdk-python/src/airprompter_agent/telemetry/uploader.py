"""The spool uploader (T26 P4, D52/D66; S5 brings it to hosts with no daemon).

Closed segments from ANY writer in ``<store>/spool/telemetry/`` are validated
line by line against the spool row contract, quarantined when they do not
fit, and POSTed straight to S3 under the heartbeat's presigned grant — one
in flight per host, oldest first, exponential backoff with full jitter
(1 s → 5 min), acknowledged segments moved to ``sent/``, ``sent/`` and
``quarantine/`` swept after 24 h, the host budget enforced across writers
with the loss written as a ``dropped`` row. Nothing here reads a row for
anything but its shape. Parity with ``sdk-typescript/src/telemetry/uploader.py``.

A grant is per INSTANCE prefix (``org/{org}/agent/{agent}/{target}/{instance}/``):
``grant_for(instance_id)`` is the heartbeat carrying that writer's instance
id — the runtime's own on a host with no daemon (S5).
"""

from __future__ import annotations

import json
import math
import os
import random as _random
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional

import httpx

from .._util import instant, iso_ms
from ..ports import FsPort, OsFs, fs_failure_code
from ..spool.writer import HOST_SPOOL_BUDGET_BYTES, LATENCY_BUCKET_EDGES_MS, SEGMENT_MAX_BYTES, epoch_minute, segment_name

UPLOAD_BACKOFF_BASE_MS = 1000
UPLOAD_BACKOFF_CAP_MS = 5 * 60 * 1000
SENT_RETENTION_MS = 24 * 60 * 60 * 1000
QUARANTINE_RETENTION_MS = 24 * 60 * 60 * 1000
#: A grant is refreshed this long before its ``expiresAt``, so an upload never starts on one about to lapse.
GRANT_REFRESH_MARGIN_MS = 60 * 1000
SEGMENT_NAME = re.compile(r"^seg-([A-Za-z0-9._~-]{8,64})-(\d+)-(\d+)\.ndjson$")

# ---------------------------------------------------------------------------
# Row validation: the spool contract, structurally
# ---------------------------------------------------------------------------

_INSTANCE_ID = re.compile(r"^[A-Za-z0-9._~-]{8,64}$")
_TAG = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")
_ARM = re.compile(r"^[a-z0-9_-]{1,32}$")
_OUTCOME_NAME = re.compile(r"^[a-z][a-zA-Z0-9]{0,31}$")
_DATE_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$")
_ERROR_CLASSES = frozenset({"render_missing_variable", "context_length_exceeded", "output_schema_invalid", "truncated", "content_filter", "provider_error", "provider_timeout", "provider_rate_limited"})
_REFUSAL_REASONS = frozenset({"disabled", "lease_expired", "payload_verification_failed", "forced_downgrade", "model_unavailable", "unlock_refused"})
_USAGE_SOURCES = frozenset({"reported", "measured", "estimated", "unavailable"})


def _is_int(value: Any, minimum: int = 0) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def _is_str(value: Any, maximum: int) -> bool:
    return isinstance(value, str) and len(value) <= maximum


def _extra_key(obj: Mapping[str, Any], allowed: tuple[str, ...]) -> Optional[str]:
    for key in obj:
        if key not in allowed:
            return key
    return None


@dataclass
class RowVerdict:
    ok: bool
    reason: Optional[str] = None
    row: Optional[dict[str, Any]] = None


def validate_spool_row(value: Any) -> RowVerdict:
    """One parsed line against the contract. The reason names the first field that does not fit — never the value."""
    if not isinstance(value, Mapping):
        return RowVerdict(False, "not_an_object")
    if value.get("v") != 1:
        return RowVerdict(False, "v")
    instance_id = value.get("instanceId")
    if not _is_str(instance_id, 64) or not _INSTANCE_ID.match(instance_id):
        return RowVerdict(False, "instanceId")
    kind = value.get("type")
    if kind == "window":
        extra = _extra_key(value, ("type", "v", "minute", "instanceId", "instanceClass", "tag", "versionId", "arm", "model", "status", "errorClass", "usageSource", "count", "latencyMs", "tokens", "checks", "outcomes", "sdk"))
        if extra:
            return RowVerdict(False, f"unknown_field:{extra}")
        if not _is_str(value.get("minute"), 64) or not _DATE_TIME.match(value["minute"]):
            return RowVerdict(False, "minute")
        if value.get("instanceClass") not in ("resident", "ephemeral"):
            return RowVerdict(False, "instanceClass")
        if not _is_str(value.get("tag"), 128) or not _TAG.match(value["tag"]):
            return RowVerdict(False, "tag")
        if not _is_str(value.get("versionId"), 128):
            return RowVerdict(False, "versionId")
        if not _is_str(value.get("arm"), 32) or not _ARM.match(value["arm"]):
            return RowVerdict(False, "arm")
        if not _is_str(value.get("model"), 128):
            return RowVerdict(False, "model")
        if value.get("status") not in ("ok", "error", "refused"):
            return RowVerdict(False, "status")
        error_class = value.get("errorClass")
        if error_class is not None and error_class not in _ERROR_CLASSES:
            return RowVerdict(False, "errorClass")
        if value.get("usageSource") not in _USAGE_SOURCES:
            return RowVerdict(False, "usageSource")
        if not _is_int(value.get("count")):
            return RowVerdict(False, "count")
        latency = value.get("latencyMs")
        if not isinstance(latency, Mapping) or _extra_key(latency, ("buckets", "sum")) or not isinstance(latency.get("buckets"), list) or len(latency["buckets"]) != len(LATENCY_BUCKET_EDGES_MS) or not all(_is_int(b) for b in latency["buckets"]) or not _is_int(latency.get("sum")):
            return RowVerdict(False, "latencyMs")
        tokens = value.get("tokens")
        if not isinstance(tokens, Mapping) or _extra_key(tokens, ("input", "cachedInput", "output")) or not _is_int(tokens.get("input")) or not _is_int(tokens.get("output")) or ("cachedInput" in tokens and not _is_int(tokens["cachedInput"])):
            return RowVerdict(False, "tokens")
        if "checks" in value:
            checks = value["checks"]
            if not isinstance(checks, Mapping) or _extra_key(checks, ("passed", "failed")) or ("passed" in checks and not _is_int(checks["passed"])) or ("failed" in checks and not _is_int(checks["failed"])):
                return RowVerdict(False, "checks")
        if "outcomes" in value:
            outcomes = value["outcomes"]
            if not isinstance(outcomes, Mapping):
                return RowVerdict(False, "outcomes")
            for name, entry in outcomes.items():
                if not _OUTCOME_NAME.match(name) or not isinstance(entry, Mapping) or _extra_key(entry, ("n", "sum")) or not _is_int(entry.get("n")) or not isinstance(entry.get("sum"), (int, float)) or isinstance(entry.get("sum"), bool) or not math.isfinite(entry["sum"]):
                    return RowVerdict(False, f"outcomes:{name}")
        if "sdk" in value and not _is_str(value["sdk"], 64):
            return RowVerdict(False, "sdk")
        return RowVerdict(True, row=dict(value))
    if kind == "refusal":
        extra = _extra_key(value, ("type", "v", "at", "instanceId", "reason", "generation", "tag"))
        if extra:
            return RowVerdict(False, f"unknown_field:{extra}")
        if not _is_str(value.get("at"), 64) or not _DATE_TIME.match(value["at"]):
            return RowVerdict(False, "at")
        if value.get("reason") not in _REFUSAL_REASONS:
            return RowVerdict(False, "reason")
        if not _is_int(value.get("generation")):
            return RowVerdict(False, "generation")
        if "tag" not in value or not (value["tag"] is None or (_is_str(value["tag"], 128) and _TAG.match(value["tag"]))):
            return RowVerdict(False, "tag")
        return RowVerdict(True, row=dict(value))
    if kind == "dropped":
        extra = _extra_key(value, ("type", "v", "at", "instanceId", "segments", "bytes"))
        if extra:
            return RowVerdict(False, f"unknown_field:{extra}")
        if not _is_str(value.get("at"), 64) or not _DATE_TIME.match(value["at"]):
            return RowVerdict(False, "at")
        if not _is_int(value.get("segments"), 1):
            return RowVerdict(False, "segments")
        if not _is_int(value.get("bytes")):
            return RowVerdict(False, "bytes")
        return RowVerdict(True, row=dict(value))
    return RowVerdict(False, "unknown_type")


@dataclass
class SegmentInspection:
    rows: list[dict[str, Any]] = field(default_factory=list)
    #: Line numbers (1-based) and reasons; empty means the segment fits the contract.
    invalid: list[dict[str, Any]] = field(default_factory=list)
    #: A last line without its newline (a crashed writer): skipped, never counted as invalid.
    partial_tail: bool = False


def inspect_segment(data: bytes, instance_id: str) -> SegmentInspection:
    """Every line of a segment against the contract; ``instance_id`` (from the file name) is authoritative for every row."""
    text = data.decode("utf-8", errors="replace")
    partial_tail = len(text) > 0 and not text.endswith("\n")
    lines = text.split("\n")
    lines.pop()  # the partial tail, or the empty string after the final newline
    inspection = SegmentInspection(partial_tail=partial_tail)
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            parsed = json.loads(line)
        except ValueError:
            inspection.invalid.append({"line": index + 1, "reason": "not_json"})
            continue
        verdict = validate_spool_row(parsed)
        if not verdict.ok:
            inspection.invalid.append({"line": index + 1, "reason": verdict.reason})
        elif verdict.row is not None and verdict.row.get("instanceId") != instance_id:
            inspection.invalid.append({"line": index + 1, "reason": "instance_mismatch"})
        elif verdict.row is not None:
            inspection.rows.append(verdict.row)
    return inspection


# ---------------------------------------------------------------------------
# The POST: a presigned S3 POST policy, multipart/form-data, fields verbatim then key then file
# ---------------------------------------------------------------------------


@dataclass
class UploadGrant:
    grant_id: str
    url: str
    fields: dict[str, str]
    key_prefix: str
    expires_at: str
    max_object_bytes: int
    content_type: str = "application/x-ndjson"

    @classmethod
    def from_wire(cls, value: Mapping[str, Any]) -> Optional["UploadGrant"]:
        if not isinstance(value, Mapping) or not isinstance(value.get("url"), str):
            return None
        return cls(str(value.get("grantId", "")), value["url"], {str(k): str(v) for k, v in (value.get("fields") or {}).items()}, str(value.get("keyPrefix", "")), str(value.get("expiresAt", "")), int(value.get("maxObjectBytes", SEGMENT_MAX_BYTES)), str(value.get("contentType") or "application/x-ndjson"))


@dataclass
class GrantDecision:
    kind: str  # "grant" | "hold" | "unavailable"
    grant: Optional[UploadGrant] = None
    upload_interval_seconds: Optional[int] = None
    retry_after_seconds: Optional[int] = None
    reason: Optional[str] = None


def multipart_body(boundary: str, fields: list[tuple[str, str]], file_name: str, content_type: str, data: bytes) -> bytes:
    parts: list[bytes] = []
    for name, value in fields:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode("utf-8"))
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{file_name}"\r\nContent-Type: {content_type}\r\n\r\n'.encode("utf-8"))
    parts.append(data)
    parts.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts)


@dataclass
class PostOutcome:
    status: str  # "ok" | "refused" | "too_large" | "network"
    key: Optional[str] = None
    http_status: Optional[int] = None
    expired: bool = False
    byte_count: Optional[int] = None
    reason: Optional[str] = None


def post_segment(*, grant: UploadGrant, segment: str, data: bytes, transport: Optional[httpx.BaseTransport] = None, now_ms: Optional[Callable[[], float]] = None, boundary: Optional[str] = None, timeout: float = 30.0) -> PostOutcome:
    """One segment under one grant. S3 PUT is idempotent by key, so a replay after a lost response overwrites identically."""
    if len(data) > grant.max_object_bytes:
        return PostOutcome("too_large", byte_count=len(data))
    now = now_ms() if now_ms else time.time() * 1000
    if instant(grant.expires_at) <= now:
        return PostOutcome("refused", http_status=403, expired=True)
    key = f"{grant.key_prefix}{segment}"
    content_type = grant.content_type or "application/x-ndjson"
    # The policy's own fields first, verbatim; `key` and `Content-Type` are what the policy conditions check; `file` last, as S3 requires.
    fields = [(name, value) for name, value in grant.fields.items() if name != "key" and name.lower() != "content-type"] + [("key", key), ("Content-Type", content_type)]
    bnd = boundary or f"----airprompter{secrets.token_hex(8)}{int(now):x}"
    body = multipart_body(bnd, fields, segment, content_type, data)
    try:
        with httpx.Client(transport=transport, timeout=timeout) as http:
            response = http.post(grant.url, headers={"content-type": f"multipart/form-data; boundary={bnd}", "content-length": str(len(body))}, content=body)
        if 200 <= response.status_code < 300:
            return PostOutcome("ok", key=key)
        text = response.text or ""
        return PostOutcome("refused", http_status=response.status_code, expired=response.status_code == 403 and re.search(r"expired|Policy expired|signature", text, re.IGNORECASE) is not None)
    except Exception as error:  # noqa: BLE001 — the network is a reason, never an exception on this path
        return PostOutcome("network", reason=str(error))


def backoff_delay_ms(attempt: int, rand: Callable[[], float] = _random.random) -> int:
    """Full jitter: uniform in [0, min(cap, base × 2^attempt)]."""
    ceiling = min(UPLOAD_BACKOFF_CAP_MS, UPLOAD_BACKOFF_BASE_MS * (2 ** max(0, attempt)))
    return max(0, round(rand() * ceiling))


# ---------------------------------------------------------------------------
# The uploader: a directory of segments from any writer, one grant per writer instance
# ---------------------------------------------------------------------------


@dataclass
class PassResult:
    uploaded: list[str] = field(default_factory=list)
    quarantined: list[str] = field(default_factory=list)
    dropped: int = 0
    held: bool = False


class SpoolUploader:
    def __init__(
        self,
        *,
        directory: str,
        instance_id: str,
        grant_for: Callable[[str], GrantDecision],
        transport: Optional[httpx.BaseTransport] = None,
        now_ms: Optional[Callable[[], float]] = None,
        fs: Optional[FsPort] = None,
        rand: Optional[Callable[[], float]] = None,
        logger: Optional[Callable[[dict[str, Any]], None]] = None,
        budget_bytes: Optional[int] = None,
        sent_retention_ms: Optional[int] = None,
        quarantine_retention_ms: Optional[int] = None,
        interval_seconds: int = 300,
    ):
        self.dir = directory
        self.instance_id = instance_id
        self._grant_for_writer = grant_for
        self._transport = transport
        self._now_ms = now_ms
        self._fs: FsPort = fs or OsFs()
        self._rand = rand or _random.random
        self._logger = logger
        self.budget_bytes = budget_bytes
        self._sent_retention_ms = sent_retention_ms if sent_retention_ms is not None else SENT_RETENTION_MS
        self._quarantine_retention_ms = quarantine_retention_ms if quarantine_retention_ms is not None else QUARANTINE_RETENTION_MS
        self._interval_seconds = interval_seconds
        self._grants: dict[str, UploadGrant] = {}
        self._last_upload_ms: Optional[float] = None
        self._last_error: Optional[str] = None
        self._backoff_until_ms: Optional[float] = None
        self._attempt = 0
        self._in_flight = threading.Lock()
        self._next_pass_ms: Optional[float] = None
        self._sent_segments = 0
        self._quarantined_segments = 0
        self._dropped_segments = 0
        self._timer: Optional[threading.Timer] = None
        self._stopped = False
        #: Filesystem failures by code — a sweep that could not stat, an evict that found the file gone (S2).
        self.fs_faults: dict[str, int] = {}
        self._fs.mkdirp(os.path.join(directory, "sent"), 0o700)
        self._fs.mkdirp(os.path.join(directory, "quarantine"), 0o700)

    # ------------------------------------------------------------------ plumbing

    def _now(self) -> float:
        return self._now_ms() if self._now_ms else time.time() * 1000

    def _log(self, event: dict[str, Any]) -> None:
        if self._logger:
            self._logger({"component": "uploader", **event})

    def _guard(self, step: str, run: Callable[[], Any]) -> bool:
        """Run a filesystem step; a failure is counted by code and returns False (a segment a sibling took away is not an error)."""
        try:
            run()
            return True
        except Exception as error:  # noqa: BLE001
            code = fs_failure_code(error)
            self.fs_faults[code] = self.fs_faults.get(code, 0) + 1
            self._log({"event": "fs_fault", "step": step, "code": code})
            return False

    def closed_segments(self) -> list[str]:
        """Closed, unsent segments, oldest first (by epoch minute, then n, then name)."""
        names = [name for name in self._fs.list(self.dir) if SEGMENT_NAME.match(name)]

        def key(name: str) -> tuple[int, int, str]:
            match = SEGMENT_NAME.match(name)
            assert match is not None
            return (int(match.group(2)), int(match.group(3)), name)

        return sorted(names, key=key)

    def depth(self) -> dict[str, int]:
        segments = self.closed_segments()
        total = 0
        for name in segments:
            def stat(name: str = name) -> None:
                nonlocal total
                total += self._fs.stat(os.path.join(self.dir, name))[0]
            self._guard("stat_segment", stat)
        return {"segments": len(segments), "bytes": total}

    def enforce_budget(self) -> int:
        """Over the host budget the OLDEST unsent segments go and the loss is one ``dropped`` row under this uploader's own id."""
        budget = self.budget_bytes if self.budget_bytes is not None else HOST_SPOOL_BUDGET_BYTES
        segments: list[tuple[str, int]] = []
        for name in self.closed_segments():
            def stat(name: str = name) -> None:
                segments.append((name, self._fs.stat(os.path.join(self.dir, name))[0]))
            self._guard("stat_segment", stat)
        total = sum(size for _, size in segments)
        evicted = 0
        evicted_bytes = 0
        for name, size in segments:
            if total <= budget:
                break
            removed = self._guard("evict_segment", lambda name=name: self._fs.unlink(os.path.join(self.dir, name)))
            total -= size
            if not removed:
                continue
            evicted += 1
            evicted_bytes += size
        if evicted > 0:
            at = self._now()
            row = {"type": "dropped", "v": 1, "at": re.sub(r"\.\d{3}Z$", "Z", iso_ms(at)), "instanceId": self.instance_id, "segments": evicted, "bytes": evicted_bytes}
            n = 0
            name = segment_name(self.instance_id, epoch_minute(at), n)
            while self._fs.exists(os.path.join(self.dir, name)) or self._fs.exists(os.path.join(self.dir, f"{name}.open")) or self._fs.exists(os.path.join(self.dir, "sent", name)):
                n += 1
                name = segment_name(self.instance_id, epoch_minute(at), n)
            self._guard("write_dropped_row", lambda: self._fs.write_file(os.path.join(self.dir, name), (json.dumps(row, separators=(",", ":")) + "\n").encode("utf-8"), 0o600))
            self._dropped_segments += evicted
            self._log({"event": "spool_evicted", "segments": evicted, "bytes": evicted_bytes})
        return evicted

    def _read_segment(self, path: str) -> Optional[bytes]:
        data: list[bytes] = []
        self._guard("read_segment", lambda: data.append(self._fs.read_file(path)))
        return data[0] if data else None

    def sweep(self) -> None:
        """``sent/`` and ``quarantine/`` entries older than their retention are deleted."""
        at = self._now()
        for sub, retention in (("sent", self._sent_retention_ms), ("quarantine", self._quarantine_retention_ms)):
            directory = os.path.join(self.dir, sub)
            for name in self._fs.list(directory):
                path = os.path.join(directory, name)

                def step(path: str = path) -> None:
                    if at - self._fs.stat(path)[1] > retention:
                        self._fs.unlink(path)

                self._guard("sweep", step)

    def _quarantine(self, name: str, reason: str, detail: Any = None) -> None:
        self._guard("quarantine", lambda: self._fs.rename(os.path.join(self.dir, name), os.path.join(self.dir, "quarantine", name)))
        self._quarantined_segments += 1
        self._log({"event": "segment_quarantined", "segment": name, "reason": reason, **({"detail": detail} if detail is not None else {})})

    def _grant_for(self, instance_id: str) -> GrantDecision:
        held = self._grants.get(instance_id)
        if held is not None and instant(held.expires_at) - GRANT_REFRESH_MARGIN_MS > self._now():
            return GrantDecision("grant", grant=held)
        self._grants.pop(instance_id, None)
        decision = self._grant_for_writer(instance_id)
        if decision.kind == "grant" and decision.grant is not None:
            self._grants[instance_id] = decision.grant
            if decision.upload_interval_seconds and decision.upload_interval_seconds >= 1:
                self._interval_seconds = int(decision.upload_interval_seconds)
        return decision

    # ------------------------------------------------------------------ the pass

    def run_once(self) -> PassResult:
        """One pass: sweep, budget, then each closed segment oldest first — validate, grant, POST, move — until the spool is empty, a hold, or a failure. Never raises; one in flight at a time."""
        with self._in_flight:
            return self._pass()

    def _pass(self) -> PassResult:
        result = PassResult()
        try:
            self.sweep()
            result.dropped = self.enforce_budget()
            if self._backoff_until_ms is not None and self._now() < self._backoff_until_ms:
                result.held = True
                return result
            for name in self.closed_segments():
                path = os.path.join(self.dir, name)
                match = SEGMENT_NAME.match(name)
                assert match is not None
                instance_id = match.group(1)
                data = self._read_segment(path)
                # Taken away between the listing and the read (a sibling's eviction): nothing to upload, nothing lost here.
                if data is None:
                    continue
                if len(data) > SEGMENT_MAX_BYTES:
                    self._quarantine(name, "oversize", len(data))
                    result.quarantined.append(name)
                    continue
                inspection = inspect_segment(data, instance_id)
                if inspection.invalid:
                    self._quarantine(name, "invalid_rows", inspection.invalid[:5])
                    result.quarantined.append(name)
                    continue
                if not inspection.rows:
                    # Nothing to say (an empty or partial-only segment): acknowledged locally, never uploaded.
                    self._guard("ack_segment", lambda: self._fs.rename(path, os.path.join(self.dir, "sent", name)))
                    continue
                decision = self._grant_for(instance_id)
                if decision.kind == "hold":
                    retry = int(decision.retry_after_seconds or 900)
                    self._backoff_until_ms = self._now() + retry * 1000
                    self._last_error = f"hold:{decision.reason or 'retry_after'}"
                    self._log({"event": "upload_held", "retryAfterSeconds": retry, "reason": decision.reason})
                    result.held = True
                    return result
                if decision.kind != "grant" or decision.grant is None:
                    self._fail(f"grant:{decision.reason}")
                    result.held = True
                    return result
                # The partial tail (a crashed writer's last line) is not sent: the bytes posted are exactly the whole lines.
                payload = data[: data.rfind(b"\n") + 1] if inspection.partial_tail else data
                outcome = post_segment(grant=decision.grant, segment=name, data=payload, transport=self._transport, now_ms=self._now)
                if outcome.status == "refused" and outcome.expired:
                    # The grant lapsed between the check and the bucket's clock: one fresh grant, one more try.
                    self._grants.pop(instance_id, None)
                    fresh = self._grant_for(instance_id)
                    if fresh.kind == "grant" and fresh.grant is not None:
                        outcome = post_segment(grant=fresh.grant, segment=name, data=payload, transport=self._transport, now_ms=self._now)
                if outcome.status == "ok":
                    self._guard("ack_segment", lambda: self._fs.rename(path, os.path.join(self.dir, "sent", name)))
                    self._sent_segments += 1
                    self._last_upload_ms = self._now()
                    self._last_error = None
                    self._attempt = 0
                    self._backoff_until_ms = None
                    result.uploaded.append(name)
                    continue
                if outcome.status == "too_large":
                    self._quarantine(name, "oversize", outcome.byte_count)
                    result.quarantined.append(name)
                    continue
                self._fail(f"http_{outcome.http_status}" if outcome.status == "refused" else f"network:{outcome.reason}")
                result.held = True
                return result
            return result
        except Exception as error:  # noqa: BLE001
            self._fail(f"pass:{error}")
            result.held = True
            return result

    def _fail(self, reason: str) -> None:
        delay = backoff_delay_ms(self._attempt, self._rand)
        self._attempt += 1
        self._backoff_until_ms = self._now() + delay
        self._last_error = reason
        self._log({"event": "upload_failed", "reason": reason, "attempt": self._attempt, "backoffMs": delay})

    # ------------------------------------------------------------------ the timer

    def start(self) -> None:
        """Passes every ``interval_seconds`` (the grant's ``uploadIntervalSeconds`` once one has answered), with a random phase offset so a fleet does not upload together."""
        self._stopped = False
        self._schedule(self._rand() * self._interval_seconds * 1000)

    def _schedule(self, delay_ms: float) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        if self._stopped:
            return
        self._next_pass_ms = self._now() + delay_ms

        def tick() -> None:
            try:
                self.run_once()
            finally:
                wait = (self._backoff_until_ms - self._now()) if self._backoff_until_ms is not None and self._backoff_until_ms > self._now() else self._interval_seconds * 1000
                self._schedule(max(250.0, wait))

        timer = threading.Timer(max(0.0, delay_ms / 1000), tick)
        timer.daemon = True
        timer.start()
        self._timer = timer

    def stop(self) -> None:
        self._stopped = True
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        self._next_pass_ms = None
        with self._in_flight:
            pass

    def status(self) -> dict[str, Any]:
        now = self._now()
        return {
            "lastUploadAt": None if self._last_upload_ms is None else iso_ms(self._last_upload_ms),
            "lastError": self._last_error,
            "backoffUntil": None if self._backoff_until_ms is None or self._backoff_until_ms <= now else iso_ms(self._backoff_until_ms),
            "attempt": self._attempt,
            "inFlight": self._in_flight.locked(),
            "intervalSeconds": self._interval_seconds,
            "nextPassAt": None if self._next_pass_ms is None or self._timer is None else iso_ms(self._next_pass_ms),
            "sentSegments": self._sent_segments,
            "quarantinedSegments": self._quarantined_segments,
            "droppedSegments": self._dropped_segments,
            "grants": [{"instanceId": instance_id, "expiresAt": grant.expires_at} for instance_id, grant in self._grants.items()],
            "depth": self.depth(),
        }

