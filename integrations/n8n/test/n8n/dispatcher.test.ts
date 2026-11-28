/**
 * n8n installs its own undici (8.12 in n8n 2.49) as the global `fetch` dispatcher. That undici refuses a request whose
 * `content-length` the caller set as well (`invalid content-length header`). The SDK's telemetry upload set one up to
 * 1.0.0-rc.4, so Report Run failed in a real n8n while passing under Node's own dispatcher; rc.5 leaves the header to
 * the HTTP client. These tests run Report Run under such a dispatcher, as n8n does, and check the SDK keeps it so.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { publicJwkOf } from "@airprompter/agent-sdk/core";
import { createAutomationClient, kvAutomationDatastore, MemoryKvStore } from "@airprompter/agent-sdk/frameworks/steps";
import type { FetchLike } from "@airprompter/agent-sdk/frameworks/steps";
import { serveOverHttp } from "@airprompter/agent-sdk/testing";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import type { IDataObject } from "n8n-workflow";

import { AirPrompter } from "../../nodes/AirPrompter/AirPrompter.node";
import { clientOptions, REQUEST_TIMEOUT_MS } from "../../src/n8n/connect";
import { harness } from "../helpers";
import { executeContext, workflow } from "../n8nContext";

function fixture() {
  const h = harness();
  h.plane.now = () => Date.now();
  h.plane.promote([h.triage("Triage {{ticket}}", "ver_1")]);
  return h;
}

const credentialsOf = (h: ReturnType<typeof harness>, baseUrl: string): IDataObject => ({ agentId: h.plane.scope.agentId, updateKey: h.plane.apiKey, environment: "prod", apiBaseUrl: baseUrl, hostedEnvironment: "prod", rootKey: JSON.stringify(publicJwkOf(h.plane.rootKey)), rootUrl: "", organizationId: "", storage: "workflowStaticData", bundlePath: "" });

test("Report Run is recorded under n8n's undici as the global dispatcher (no workaround in the node)", async () => {
  const previous = getGlobalDispatcher();
  const agent = new Agent();
  const h = fixture();
  let server: Awaited<ReturnType<typeof serveOverHttp>> | undefined;
  try {
    setGlobalDispatcher(agent);
    server = await serveOverHttp(h.plane, { port: 0 });
    h.plane.grantBaseUrl = server.baseUrl;
    const credentials = credentialsOf(h, server.baseUrl);
    const node = new AirPrompter();
    const wf = workflow();
    const [got] = await node.execute.call(executeContext({ wf, credentials, params: { operation: "getPrompt", slot: "support.triage", variables: { mappingMode: "defineBelow", value: { ticket: "t" } } } }) as never);
    const runRef = (got![0]!.json as { runRef: string }).runRef;
    const [reported] = await node.execute.call(executeContext({ wf, credentials, items: [{ usage: { prompt_tokens: 5, completion_tokens: 2 } }], params: { operation: "reportRun", runRef, usageFrom: "detect", additional: { thumbs: "up" } } }) as never);
    assert.equal((reported![0]!.json as { airprompter: { reported: boolean } }).airprompter.reported, true);
  } finally {
    await server?.close();
    setGlobalDispatcher(previous);
    await agent.close();
  }
});

test("the SDK leaves content-length to the HTTP client on its telemetry upload (rc.5 and later)", async () => {
  // Independent of any undici version: record what the core hands to fetch, through the plane's in-process fetch.
  const h = fixture();
  h.plane.grantBaseUrl = "https://bucket.test";
  const inner = h.plane.fetch();
  const uploads: Array<Record<string, string>> = [];
  const recording: FetchLike = async (url, init) => {
    if (String(url).startsWith("https://bucket.test")) uploads.push(Object.fromEntries(new Headers(init?.headers as HeadersInit).entries()));
    return inner(url, init);
  };
  const core = createAutomationClient({ ...clientOptions(credentialsOf(h, "https://api.test") as never, kvAutomationDatastore(new MemoryKvStore())), fetch: recording });
  const served = await core.getPrompt({ slot: "support.triage", variables: { ticket: "t" } });
  await core.reportRun({ runRef: served.runRef, inputTokens: 1 });
  assert.ok(uploads.length > 0, "the report went out as a telemetry upload");
  assert.ok(uploads.every((headers) => !("content-length" in headers)), "the SDK must not set content-length itself: n8n's undici refuses it");
});

test("the node hands the core one timeout and uses the core's own fetch", () => {
  const h = fixture();
  const defaults = clientOptions(credentialsOf(h, "https://api.test") as never, kvAutomationDatastore(new MemoryKvStore()));
  assert.equal(defaults.requestTimeoutMs, REQUEST_TIMEOUT_MS);
  assert.equal(defaults.fetch, undefined, "no fetch of the node's own: the core's timedFetch over globalThis.fetch");
  assert.equal(clientOptions(credentialsOf(h, "https://api.test") as never, kvAutomationDatastore(new MemoryKvStore()), { requestTimeoutMs: 500 }).requestTimeoutMs, 500);
});
