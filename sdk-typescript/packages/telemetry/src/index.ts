/**
 * `@airprompter/agent-telemetry` — the content-free spool and its uploader:
 * minute windows written as append-only segments (or held in memory on a
 * serverless host), the host budget, and the direct-to-object-store upload
 * under a grant. Builds on the row schemas in `@airprompter/agent-core`
 * and never imports the sync or the runtime package (S10): a customer's
 * own instrumentation can write the spool with this package alone.
 */

export { SpoolWriter, DirectorySink, MemorySink, SegmentPlanner, segmentName, SEGMENT_MAX_BYTES, HOST_SPOOL_BUDGET_BYTES, SERVERLESS_BUFFER_BYTES } from "./spool/writer.js";
export type { SpoolSink, SinkFaults } from "./spool/writer.js";
export { LATENCY_BUCKET_EDGES_MS, latencyBucketIndex, minuteOf, epochMinute } from "@airprompter/agent-core";
export type { Observation, WindowRow, RefusalRow, DroppedRow, SpoolRow, ErrorClass } from "@airprompter/agent-core";
export type { UploadSink, UploadSegment, UploadOutcome } from "@airprompter/agent-core";

export { SpoolUploader, airprompterUploadSink, validateSpoolRow, inspectSegment, postSegment, multipartBody, backoffDelayMs, UPLOAD_BACKOFF_BASE_MS, UPLOAD_BACKOFF_CAP_MS, GRANT_REFRESH_MARGIN_MS, LAST_UPLOAD_MARKER, QUARANTINE_CAP_BYTES, QUARANTINE_RETENTION_MS, EXPORTED_CAP_BYTES, OPEN_SEGMENT_RECLAIM_MS, SEGMENT_NAME, OPEN_SEGMENT_NAME } from "./uploader.js";
export type { UploadGrant, GrantDecision, UploaderOptions, UploaderStatus, PassResult, PostOutcome, RowVerdict, SegmentInspection } from "./uploader.js";
