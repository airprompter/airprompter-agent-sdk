/**
 * The testing kit (S2, AIR-1970): what our own vectors run over and what a
 * customer's CI can import to prove the same things about their host —
 * a filesystem that fills, fails and loses files (`MemoryFs`), a clock
 * that advances and skews (`FakeClock`), and the fake registry the SDK
 * tests use (`FakeControlPlane`: signed manifests, refusals, lease and a
 * 15-minute upload grant that expires). Nothing here is ever loaded by the
 * runtime.
 *
 * @example
 * ```ts
 * import { AirPrompterAgent, publicJwkOf } from "@airprompter/agent-sdk";
 * import { FakeClock, FakeControlPlane, MemoryFs } from "@airprompter/agent-sdk/testing";
 *
 * const plane = new FakeControlPlane({ organizationId: "org_1", agentId: "agt_1", target: "prod" });
 * plane.promote([plane.slot({ tag: "support.reply", text: "Reply politely." })]); // generation 1, signed
 * const ap = await AirPrompterAgent.start({ ...plane.scope, apiKey: plane.apiKey, baseUrl: "https://api.test", stateDir, root: { pinned: publicJwkOf(plane.rootKey) }, fetch: plane.fetch() });
 * ```
 */

import type { ClockPort } from "../protocol/ports.js";

export { MemoryFs } from "./memoryFs.js";
export { FakeControlPlane, PROTOCOL, newKey, rootDocument, serveOverHttp, type SlotSpec } from "./controlPlane.js";

/** A clock a test moves by hand: `advance(ms)`, or `skew(ms)` to model a host whose clock is off. */
export class FakeClock implements ClockPort {
  private offsetMs = 0;
  constructor(private currentMs: number = Date.UTC(2026, 8, 13, 12, 0, 0)) {}
  nowMs(): number {
    return this.currentMs + this.offsetMs;
  }
  advance(ms: number): void {
    this.currentMs += ms;
  }
  set(ms: number): void {
    this.currentMs = ms;
  }
  /** Two hosts with the same `currentMs` and different skews disagree by the difference — the ramp walk's vector. */
  skew(ms: number): void {
    this.offsetMs = ms;
  }
  /** The `now` callback the facade and uploader accept. */
  readonly now = (): number => this.nowMs();
}
