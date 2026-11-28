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
    HOST_SPOOL_BUDGET_BYTES,
    SEGMENT_MAX_BYTES,
    SERVERLESS_BUFFER_BYTES,
    DirectorySink,
    MemorySink,
    Observation,
    SpoolSink,
    SpoolWriter,
    WriterIdentity,
    epoch_minute,
    segment_name,
)
from .spool.manifest import read_daemon_discovery
from .uploader import (
    AirPrompterUploadSink,
    GrantDecision,
    PassResult,
    SpoolUploader,
    UploadGrant,
    inspect_segment,
    post_segment,
)

# The names 1.0 promises (docs/stability.md), one per line: tests/test_package_shape.py pins them. Every other name
# imported above is the layer's own, for the layers above it, and not public.
__all__ = [
    "AirPrompterUploadSink",
    "DirectorySink",
    "GrantDecision",
    "HOST_SPOOL_BUDGET_BYTES",
    "MemorySink",
    "PassResult",
    "SEGMENT_MAX_BYTES",
    "SERVERLESS_BUFFER_BYTES",
    "SpoolSink",
    "SpoolUploader",
    "SpoolWriter",
    "UploadGrant",
    "WriterIdentity",
    "inspect_segment",
]

# Imported for the layers above and never public: named here so each import is used on purpose, and so no one
# reads one as a promise. tests/test_package_shape.py checks this and ``__all__`` cover every import, apart.
_FOR_THE_LAYERS_ABOVE = (
    Observation,
    epoch_minute,
    post_segment,
    read_daemon_discovery,
    segment_name,
)
