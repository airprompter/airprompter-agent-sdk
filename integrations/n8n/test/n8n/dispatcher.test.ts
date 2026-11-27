/**
 * n8n installs its own undici as the global `fetch` dispatcher. That undici refuses a request whose `content-length`
 * the caller set as well (`invalid content-length header`), which the SDK's telemetry upload does in 1.0.0-rc.4, so
 * Report Run failed in a real n8n (2.49.8) while passing here. This file runs under such a dispatcher, as n8n does.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { publicJwkOf } from "@airprompter/agent-sdk/core";
import { createAutomationClient, kvAutomationDatastore, MemoryKvStore } from "@airprompter/agent-sdk/frameworks/steps";
import { serveOverHttp } from "@airprompter/agent-sdk/testing";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import type { IDataObject } from "n8n-workflow";

import { AirPrompter } from "../../nodes/AirPrompter/AirPrompter.node";
import { clientOptions } from "../../src/n8n/connect";
import { harness } from "../helpers";
import { executeContext, workflow } from "../n8nContext";

test("Report Run is recorded under a userland undici dispatcher, as inside n8n", async () => {
  const previous = getGlobalDispatcher();
  setGlobalDispatcher(new Agent());
  const h = harness();
  h.plane.now = () => Date.now();
  h.plane.promote([h.triage("Triage {{ticket}}", "ver_1")]);
  const server = await serveOverHttp(h.plane, { port: 0 });
  h.plane.grantBaseUrl = server.baseUrl;
  const credentials: IDataObject = { agentId: h.plane.scope.agentId, updateKey: h.plane.apiKey, environment: "prod", apiBaseUrl: server.baseUrl, hostedEnvironment: "prod", rootKey: JSON.stringify(publicJwkOf(h.plane.rootKey)), rootUrl: "", organizationId: "", storage: "workflowStaticData", bundlePath: "" };
  const node = new AirPrompter();
  const wf = workflow();
  try {
    const [got] = await node.execute.call(executeContext({ wf, credentials, params: { operation: "getPrompt", slot: "support.triage", variables: { mappingMode: "defineBelow", value: { ticket: "t" } } } }) as never);
    const runRef = (got![0]!.json as { runRef: string }).runRef;
    const [reported] = await node.execute.call(executeContext({ wf, credentials, items: [{ usage: { prompt_tokens: 5, completion_tokens: 2 } }], params: { operation: "reportRun", runRef, usageFrom: "detect", additional: { thumbs: "up" } } }) as never);
    assert.equal((reported![0]!.json as { airprompter: { reported: boolean } }).airprompter.reported, true);

    // The SDK's own default fetch still sends the header. When this stops failing, the SDK fixed it: drop
    // `withoutContentLength` from src/n8n/connect.ts and this half of the test.
    const { fetch: _ours, ...coreDefaults } = clientOptions(credentials as never, kvAutomationDatastore(new MemoryKvStore()));
    const core = createAutomationClient(coreDefaults);
    const served = await core.getPrompt({ slot: "support.triage", variables: { ticket: "t" } });
    await assert.rejects(core.reportRun({ runRef: served.runRef, inputTokens: 1 }), /could not take the report/);
  } finally {
    await server.close();
    setGlobalDispatcher(previous);
  }
});
