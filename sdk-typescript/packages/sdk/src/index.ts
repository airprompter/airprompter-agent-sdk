/**
 * `@airprompter/agent-sdk` — one install, today's `AirPrompterAgent`: the
 * facade over `@airprompter/agent-core`, `-sync`, `-runtime` and
 * `-telemetry` (exact-pinned siblings, one version), with every public name
 * of those packages re-exported so a customer who installs only this one
 * sees the whole surface (S10). A customer who wants less installs the
 * sibling directly: the runtime alone renders and assigns over a bundle,
 * the sync package alone pulls and verifies in CI, the telemetry package
 * alone writes the spool from their own instrumentation.
 */

export { AirPrompterAgent, AgentStartError, isAgentStartError, RenderRefusedError, SDK_NAME, SDK_VERSION, PROTOCOL_VERSION, VENDORED_BUNDLE_EXPIRY_WARNING_DAYS, healthzOf, healthzResponse } from "./agent.js";
export type { AgentStatus, Healthz, Rendered, StartOptions, SyncMode, ReleaseSource, ReleaseChange, SpoolReport, HeartbeatSdkName, BundleOutcome } from "./agent.js";

export * from "@airprompter/agent-core";
export * from "@airprompter/agent-sync";
export * from "@airprompter/agent-runtime";
export * from "@airprompter/agent-telemetry";
