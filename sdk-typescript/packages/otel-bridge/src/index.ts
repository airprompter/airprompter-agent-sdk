/**
 * `@airprompter/otel-bridge` — the spool as an OTLP exporter (S13): the
 * telemetry windows a host already writes go to the OpenTelemetry collector
 * the customer already runs, as metrics, with no AirPrompter grant at all.
 * Draws the `UploadSink` port in `@airprompter/agent-core`; the uploader in
 * `@airprompter/agent-telemetry` (in `airprompterd` or in-process) hands it
 * every validated segment. A separate package because a collector is an
 * optional destination and its exporters carry their own dependencies.
 *
 * @example
 * ```ts
 * import { otlpUploadSink } from "@airprompter/otel-bridge";
 *
 * const sink = otlpUploadSink({ endpoint: "http://localhost:4318/v1/metrics", resource: { "service.name": "support-bot" } });
 * const uploader = new SpoolUploader({ dir, instanceId, sink }); // no grantFor: nothing goes to AirPrompter
 * uploader.start();
 * ```
 */

export { spoolRowsToOtlp, otlpAttribute, OTLP_SCOPE_NAME } from "./mapping.js";
export type { ExportMetricsServiceRequest, OtlpMetric, OtlpAttribute, OtlpHistogramPoint, OtlpNumberPoint, OtlpValue, MappingOptions } from "./mapping.js";
export { otlpUploadSink, httpJsonExporter } from "./sink.js";
export type { OtlpExporter, OtlpSinkOptions, OtlpSinkStatus } from "./sink.js";
