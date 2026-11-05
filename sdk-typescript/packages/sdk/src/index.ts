/**
 * `@airprompter/agent-sdk`: one install. The root is `AirPrompterAgent`, its
 * option and result types, and the hosted client. Everything else is reached
 * through a subpath, so each name has one home and a customer who wants less
 * imports less: `/core` is the protocol with no I/O, `/sync` pulls and holds
 * releases, `/runtime` renders and assigns over a release you hold, `/telemetry`
 * writes the spool and uploads it, `/testing` is the CI kit, and
 * `/frameworks/<name>` is an adapter with its framework as an optional peer.
 *
 * Every name is listed: a star export here would make every addition to a layer
 * public by accident. `test/packageShape.test.ts` pins this list and the exports map.
 *
 * @example
 * ```ts
 * import { AirPrompterAgent } from "@airprompter/agent-sdk";
 *
 * const ap = await AirPrompterAgent.start({ organizationId, agentId, target: "prod", apiKey: process.env.AIRPROMPTER_AGENT_KEY, root: { pinned: PINNED_ROOT_JWK } });
 * const r = ap.prompt("support.triage").render({ team: "Billing", ticket: userMessage }); // never touches the network
 * const reply = await ap.observe(r, () => openai.chat.completions.create({ model: r.model, messages: [{ role: "user", content: r.text }] }));
 * ap.feedback(r.runRef, { thumbs: "up" });
 * ```
 */

export { AirPrompterAgent, AgentStartError, isAgentStartError, RenderRefusedError, SDK_NAME, SDK_VERSION, PROTOCOL_VERSION, VENDORED_BUNDLE_EXPIRY_WARNING_DAYS, healthzOf, healthzResponse } from "./agent.js";
export type { AgentRampStatus, AgentStatus, Healthz, Rendered, StartOptions, SyncMode, ReleaseSource, ReleaseChange, SpoolReport, TelemetryPlacement, HeartbeatSdkName, BundleOutcome, HydrateOutcome, DatastoreStatus } from "./agent.js";

// The hosted client: the README's quick start for running with no release on the host.
export { ManagedAgent, ManagedRunError, isManagedRunError } from "./runtime/index.js";
export type { ManagedStartOptions, ManagedRunOptions, ManagedRunResult, ManagedRunStream } from "./runtime/index.js";
