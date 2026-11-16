/**
 * Test fixtures: the SDK's fake control plane (the same one `airprompter dev` serves) behind a switchable `fetch`,
 * so a test can take AirPrompter down, tamper with what is stored, and move the clock.
 */
import { publicJwkOf, releaseDigest } from "@airprompter/agent-sdk/core";
import type { ManifestSlot } from "@airprompter/agent-sdk/core";
import { FakeControlPlane } from "@airprompter/agent-sdk/testing";
import { MemoryKvStore, createAutomationClient, kvAutomationDatastore } from "@airprompter/agent-sdk/frameworks/steps";
import type { AutomationClient, AutomationClientOptions, FetchLike } from "@airprompter/agent-sdk/frameworks/steps";

export const SCOPE = { organizationId: "org_test", agentId: "agt_n8n", target: "prod" as const };
export const BASE_URL = "https://api.test";

export interface Harness {
  plane: FakeControlPlane;
  kv: MemoryKvStore;
  online: { value: boolean };
  clock: { now: number };
  fetch: FetchLike;
  client(overrides?: Partial<AutomationClientOptions>): AutomationClient;
  triage(text: string, versionId: string, ordinal?: number): ManifestSlot;
}

export function harness(): Harness {
  const plane = new FakeControlPlane(SCOPE);
  plane.grantBaseUrl = "https://bucket.test";
  const kv = new MemoryKvStore();
  const online = { value: true };
  const clock = { now: Date.now() };
  plane.now = () => clock.now;
  const inner = plane.fetch();
  const fetch: FetchLike = async (url, init) => {
    if (!online.value) throw new Error("getaddrinfo ENOTFOUND api.test");
    return inner(url, init);
  };
  const datastore = kvAutomationDatastore(kv);
  return {
    plane,
    kv,
    online,
    clock,
    fetch,
    client: (overrides = {}) =>
      createAutomationClient({
        agentId: SCOPE.agentId,
        updateKey: plane.apiKey,
        baseUrl: BASE_URL,
        datastore,
        environment: "prod",
        root: publicJwkOf(plane.rootKey),
        fetch,
        now: () => clock.now,
        ...overrides,
      }),
    triage: (text, versionId, ordinal = 1) => {
      const slot = plane.slot({ tag: "support.triage", text, versionId, model: "gpt-5-mini", variables: [{ name: "ticket", required: true, trust: "end_user" }, { name: "team", required: false, trust: "operator", default: "Support" }], inference: { temperatureMilli: 200, maxOutputTokens: 400 } });
      return { ...slot, versionOrdinal: ordinal };
    },
  };
}

/** A 50/50 A/B test on the triage slot, with an optional signed ramp. */
export function abTest(h: Harness, control: ManifestSlot, candidate: ManifestSlot, weights: [number, number] = [5000, 5000], ramp?: Array<{ notBefore: string; weightBps: number[] }>) {
  return {
    experimentId: "exp_triage",
    tag: control.tag,
    salt: "AAECAwQFBgcICQoLDA0ODw",
    subjectKey: "request" as const,
    arms: [
      { arm: "control", weightBps: weights[0], releaseDigest: releaseDigest([control]), overrides: [] },
      { arm: "candidate", weightBps: weights[1], releaseDigest: releaseDigest([candidate]), overrides: [candidate] },
    ],
    ...(ramp ? { ramp } : {}),
  };
}
