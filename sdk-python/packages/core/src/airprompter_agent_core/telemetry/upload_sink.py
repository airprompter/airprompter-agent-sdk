"""Where validated spool segments go (S13): the ``UploadSink`` port.

The uploader in ``airprompter_agent_telemetry`` owns the spool — the sweep,
the budget, the quarantine, the delete-on-ack — and hands each validated
segment to a sink. Two sinks ship: AirPrompter's (a grant per writer from
the heartbeat, a PUT to the customer's own prefix) and the OpenTelemetry
bridge (``airprompter_agent_telemetry.otel``: the windows as OTLP metrics to
the collector the customer already runs, no AirPrompter grant at all). A
sink is data, never a class hierarchy: ``kind`` says what it is. Parity with
``sdk-typescript/packages/core/src/telemetry/uploadSink.ts``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional, Protocol, runtime_checkable


@dataclass
class UploadSegment:
    #: The writer whose segment this is (the instance id in the file name).
    instance_id: str
    #: The segment's file name: the object key on AirPrompter's side, a label elsewhere.
    segment: str
    #: The validated rows, in order.
    rows: list[dict[str, Any]]
    #: Exactly the whole lines, as bytes — what AirPrompter's sink posts.
    data: bytes


@dataclass
class UploadOutcome:
    """What a sink says about one segment.

    - ``ok``: shipped; the uploader deletes the segment.
    - ``hold``: not now (a grant is throttled, a collector asked for backoff); the uploader keeps the segment and waits ``retry_after_ms``.
    - ``failed``: try again later under backoff; the segment stays under the budget.
    - ``dropped``: the sink gave up on this segment for good (the bridge's drop-and-count); the uploader deletes it and counts the loss.
    - ``too_large``: the receiver refused the size; the segment is quarantined.
    """

    status: str  # "ok" | "hold" | "failed" | "dropped" | "too_large"
    reason: Optional[str] = None
    retry_after_ms: Optional[int] = None
    byte_count: Optional[int] = None


@runtime_checkable
class UploadSink(Protocol):
    #: What the sink is, as data: ``"airprompter"``, ``"otlp"``, or a customer's own. Never branch on a class.
    kind: str

    def ship(self, segment: UploadSegment) -> UploadOutcome: ...


def sink_status(sink: Any) -> dict[str, Any]:
    """A sink's live state for ``status`` (grants held, the collector's last answer); ``{}`` when it reports none."""
    status = getattr(sink, "status", None)
    if not callable(status):
        return {}
    value = status()
    return dict(value) if isinstance(value, dict) else {}


__all__ = ["UploadOutcome", "UploadSegment", "UploadSink", "sink_status"]
