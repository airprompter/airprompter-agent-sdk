"""``airprompter_agent.telemetry``: the content-free spool and its uploader: minute windows written as append-only
segments (or held in memory on a serverless host), the host budget, and the direct-to-object-store upload under a
grant. Builds on the row schemas in ``airprompter_agent.core`` and never imports the sync or the runtime layer, so a
customer's own instrumentation writes the spool through this one layer's names.

Example::

    from airprompter_agent.telemetry import DirectorySink, Observation, SpoolWriter, WriterIdentity

    writer = SpoolWriter(DirectorySink(spool_dir, "i-hostprocess000"), WriterIdentity("i-hostprocess000", "resident", "acme/1.0"))
    writer.observe(Observation(tag="support.reply", artifact_id="prm_reply", version_id="ver_9", arm="none", model="gpt-5", status="ok", latency_ms=812), now_ms)
"""

from .spool.writer import (
    ERROR_CLASSES,
    HOST_SPOOL_BUDGET_BYTES,
    LATENCY_BUCKET_EDGES_MS,
    SEGMENT_MAX_BYTES,
    SERVERLESS_BUFFER_BYTES,
    DirectorySink,
    MemorySink,
    Observation,
    RunDimensions,
    RunTotals,
    SegmentPlanner,
    SpoolRow,
    SpoolSink,
    SpoolWriter,
    StepTotals,
    WriterIdentity,
    epoch_minute,
    latency_bucket_index,
    minute_of,
    segment_name,
)
from .spool.manifest import (
    DAEMON_DISCOVERY_FILE,
    DAEMON_DISCOVERY_FORMAT,
    DAEMON_DISCOVERY_MAX_AGE_MS,
    DAEMON_DISCOVERY_REFRESH_MS,
    MANIFEST_GRACE_MS,
    MANIFEST_NAME,
    MANIFEST_SUFFIX,
    SPOOL_MANIFEST_FORMAT,
    daemon_discovery_path,
    manifest_name_of,
    read_daemon_discovery,
    read_segment_manifest,
    remove_daemon_discovery,
    segment_name_of_manifest,
    sha256_hex,
    write_daemon_discovery,
    write_segment_manifest,
)
from .uploader import AirPrompterUploadSink, GrantDecision, PassResult, SpoolUploader, UploadGrant, backoff_delay_ms, inspect_segment, post_segment, validate_spool_row

__all__ = [
    "DAEMON_DISCOVERY_FILE",
    "DAEMON_DISCOVERY_FORMAT",
    "DAEMON_DISCOVERY_MAX_AGE_MS",
    "DAEMON_DISCOVERY_REFRESH_MS",
    "MANIFEST_GRACE_MS",
    "MANIFEST_NAME",
    "MANIFEST_SUFFIX",
    "SPOOL_MANIFEST_FORMAT",
    "daemon_discovery_path",
    "manifest_name_of",
    "read_daemon_discovery",
    "read_segment_manifest",
    "remove_daemon_discovery",
    "segment_name_of_manifest",
    "sha256_hex",
    "write_daemon_discovery",
    "write_segment_manifest",
    "AirPrompterUploadSink",
    "DirectorySink",
    "ERROR_CLASSES",
    "GrantDecision",
    "HOST_SPOOL_BUDGET_BYTES",
    "LATENCY_BUCKET_EDGES_MS",
    "MemorySink",
    "Observation",
    "PassResult",
    "RunDimensions",
    "RunTotals",
    "SEGMENT_MAX_BYTES",
    "SERVERLESS_BUFFER_BYTES",
    "SegmentPlanner",
    "SpoolRow",
    "SpoolSink",
    "SpoolUploader",
    "SpoolWriter",
    "StepTotals",
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
