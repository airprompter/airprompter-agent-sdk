/**
 * `@airprompter/agent-sdk/telemetry`, the names 1.0 promises: the content-free spool and its uploader. Minute windows
 * written as segments to a directory (or held in memory on a serverless host), and shipped under a grant or to any
 * `UploadSink`. The row schemas and `UploadSink` itself have one home, `@airprompter/agent-sdk/core`.
 *
 * This file is the subpath; `./index.ts` is the layer's barrel, what the agent and the daemon import, and nothing a
 * customer can reach. `test/publicSurface.test.ts` pins this list; `docs/stability.md` says what the promise covers.
 *
 * @example
 * ```ts
 * import { DirectorySink, SpoolWriter } from "@airprompter/agent-sdk/telemetry";
 *
 * const writer = new SpoolWriter(new DirectorySink(dir, instanceId), { instanceId, instanceClass: "resident", sdk: "my-service/1.4.0" });
 * ```
 */

// Writing the spool.
export { DirectorySink, HOST_SPOOL_BUDGET_BYTES, MemorySink, SEGMENT_MAX_BYTES, SERVERLESS_BUFFER_BYTES, SpoolWriter } from "./index.js";
export type { DirectorySinkOptions, OutcomeDimensions, SinkFaults, SpoolSink } from "./index.js";

// Shipping it.
export { SpoolUploader, airprompterUploadSink, inspectSegment } from "./index.js";
export type { GrantDecision, PassResult, SegmentInspection, UploadGrant, UploaderOptions, UploaderStatus } from "./index.js";
