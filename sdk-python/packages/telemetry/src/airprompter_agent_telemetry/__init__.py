"""``airprompter_agent_telemetry`` — the content-free spool and its uploader: minute windows written as append-only
segments (or held in memory on a serverless host), the host budget, and the direct-to-object-store upload under a
grant. Builds on the row schemas in ``airprompter_agent_core`` and never imports the sync or the runtime package
(S10): a customer's own instrumentation can write the spool with this package alone."""

from .spool.writer import (
    ERROR_CLASSES,
    HOST_SPOOL_BUDGET_BYTES,
    LATENCY_BUCKET_EDGES_MS,
    SEGMENT_MAX_BYTES,
    SERVERLESS_BUFFER_BYTES,
    DirectorySink,
    MemorySink,
    Observation,
    SegmentPlanner,
    SpoolRow,
    SpoolSink,
    SpoolWriter,
    WriterIdentity,
    epoch_minute,
    latency_bucket_index,
    minute_of,
    segment_name,
)
from .uploader import GrantDecision, PassResult, SpoolUploader, UploadGrant, backoff_delay_ms, inspect_segment, post_segment, validate_spool_row

__all__ = [
    "DirectorySink",
    "ERROR_CLASSES",
    "GrantDecision",
    "HOST_SPOOL_BUDGET_BYTES",
    "LATENCY_BUCKET_EDGES_MS",
    "MemorySink",
    "Observation",
    "PassResult",
    "SEGMENT_MAX_BYTES",
    "SERVERLESS_BUFFER_BYTES",
    "SegmentPlanner",
    "SpoolRow",
    "SpoolSink",
    "SpoolUploader",
    "SpoolWriter",
    "UploadGrant",
    "WriterIdentity",
    "backoff_delay_ms",
    "epoch_minute",
    "inspect_segment",
    "latency_bucket_index",
    "minute_of",
    "post_segment",
    "segment_name",
    "validate_spool_row",
]
