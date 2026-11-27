/**
 * `@airprompter/agent-sdk/testing`: the CI kit, re-exported from `core/testing`; never loaded by
 * the runtime. A customer's tests start the facade against `FakeControlPlane` and run the spool over `MemoryFs`.
 *
 * @example
 * ```ts
 * import { AirPrompterAgent } from "@airprompter/agent-sdk";
 * import { publicJwkOf } from "@airprompter/agent-sdk/core";
 * import { FakeControlPlane } from "@airprompter/agent-sdk/testing";
 *
 * const plane = new FakeControlPlane({ organizationId: "org_1", agentId: "agt_1", target: "prod" });
 * plane.promote([plane.slot({ tag: "support.reply", text: "Reply politely." })]);
 * const ap = await AirPrompterAgent.start({ ...plane.scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, sync: { rootUrl: "https://api.test/roots/prod/root.json" }, fetch: plane.fetch() }); // the fake's own root: not a hosted one, so its rootUrl is named
 * ```
 *
 * The names 1.0 promises are listed, never a star export: `test/publicSurface.test.ts` pins them.
 */
export { FakeClock, FakeControlPlane, MemoryFs, serveOverHttp } from "./core/testing/index.js";
export type { SlotSpec } from "./core/testing/index.js";
