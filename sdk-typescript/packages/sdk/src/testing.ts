/**
 * `@airprompter/agent-sdk/testing`: the CI kit, re-exported from `@airprompter/agent-core/testing` — never loaded by
 * the runtime. A customer's tests start the facade against `FakeControlPlane` and run the spool over `MemoryFs`.
 *
 * @example
 * ```ts
 * import { AirPrompterAgent, publicJwkOf } from "@airprompter/agent-sdk";
 * import { FakeControlPlane } from "@airprompter/agent-sdk/testing";
 *
 * const plane = new FakeControlPlane({ organizationId: "org_1", agentId: "agt_1", target: "prod" });
 * plane.promote([plane.slot({ tag: "support.reply", text: "Reply politely." })]);
 * const ap = await AirPrompterAgent.start({ ...plane.scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: plane.fetch() });
 * ```
 */
export * from "@airprompter/agent-core/testing";
