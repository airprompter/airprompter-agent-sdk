/**
 * The n8n nodes with mocked n8n contexts against the SDK's fake control plane on a loopback HTTP listener (the
 * listener `airprompter dev` uses), so the nodes' own network path — global fetch — is exercised.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publicJwkOf } from "@airprompter/agent-sdk/core";
import { FakeControlPlane, serveOverHttp } from "@airprompter/agent-sdk/testing";
import type { IDataObject } from "n8n-workflow";

import { AirPrompterAgentApi } from "../../credentials/AirPrompterAgentApi.credentials";
import { AirPrompter } from "../../nodes/AirPrompter/AirPrompter.node";
import { AirPrompterTrigger } from "../../nodes/AirPrompterTrigger/AirPrompterTrigger.node";
import { abTest, harness } from "../helpers";
import { executeContext, loadOptionsContext, pollContext, workflow } from "../n8nContext";

async function served(plane: FakeControlPlane) {
  const server = await serveOverHttp(plane, { port: 0 });
  // The fake bucket the upload grant names sits behind the same listener.
  plane.grantBaseUrl = server.baseUrl;
  return server;
}

function credentialsFor(plane: FakeControlPlane, baseUrl: string, storage: "userFolder" | "workflowStaticData" = "workflowStaticData"): IDataObject {
  return { agentId: plane.scope.agentId, updateKey: plane.apiKey, environment: "prod", apiBaseUrl: baseUrl, hostedEnvironment: "prod", rootKey: JSON.stringify(publicJwkOf(plane.rootKey)), rootUrl: "", organizationId: "", storage, bundlePath: "" };
}

const node = new AirPrompter();
const trigger = new AirPrompterTrigger();

test("the credential declares the fields the nodes read, and its test verifies the signed manifest", async () => {
  const fields = new AirPrompterAgentApi().properties.map((p) => p.name);
  for (const name of ["agentId", "updateKey", "environment", "rootKey", "apiBaseUrl", "hostedEnvironment", "storage"]) assert.ok(fields.includes(name), name);
  const h = harness();
  h.plane.promote([h.triage("Triage {{ticket}}", "ver_1")]);
  const server = await served(h.plane);
  try {
    const ok = await node.methods.credentialTest.airPrompterAgentApiTest.call({} as never, { id: "c", name: "c", type: "airPrompterAgentApi", data: credentialsFor(h.plane, server.baseUrl) } as never);
    assert.equal(ok.status, "OK", ok.message);
    const bad = await node.methods.credentialTest.airPrompterAgentApiTest.call({} as never, { id: "c", name: "c", type: "airPrompterAgentApi", data: { ...credentialsFor(h.plane, server.baseUrl), updateKey: "nope" } } as never);
    assert.equal(bad.status, "Error");
    const badRoot = await node.methods.credentialTest.airPrompterAgentApiTest.call({} as never, { id: "c", name: "c", type: "airPrompterAgentApi", data: { ...credentialsFor(h.plane, server.baseUrl), rootKey: "not json" } } as never);
    assert.equal(badRoot.status, "Error");
    assert.match(badRoot.message, /JSON Web Key/);
    // The root is optional (the SDK pins hosted roots), and a deployment with no pinned root and none given fails the test with the reason.
    assert.ok(!new AirPrompterAgentApi().properties.find((p) => p.name === "rootKey")!.required, "Root Public Key is optional");
    const unpinned = await node.methods.credentialTest.airPrompterAgentApiTest.call({} as never, { id: "c", name: "c", type: "airPrompterAgentApi", data: { ...credentialsFor(h.plane, server.baseUrl), rootKey: "", hostedEnvironment: "staging" } } as never);
    assert.equal(unpinned.status, "Error");
    assert.match(unpinned.message, /root key is pinned/i);
    // The credential text says Production needs the key in this version: true while the SDK it depends on (1.0.0-rc.4)
    // pins only Dev. When the SDK pins Production, this fails: update the Root Public Key description and README.
    const prodUnpinned = await node.methods.credentialTest.airPrompterAgentApiTest.call({} as never, { id: "c", name: "c", type: "airPrompterAgentApi", data: { ...credentialsFor(h.plane, server.baseUrl), rootKey: "", hostedEnvironment: "prod" } } as never);
    assert.equal(prodUnpinned.status, "Error");
    assert.match(prodUnpinned.message, /root key is pinned for the prod/i);
  } finally {
    await server.close();
  }
});

test("load options list the slots; the resource mapper offers the slot's variables", async () => {
  const h = harness();
  h.plane.promote([h.triage("Triage {{ticket}} for {{team}}", "ver_1")]);
  const server = await served(h.plane);
  const wf = workflow();
  try {
    const credentials = credentialsFor(h.plane, server.baseUrl);
    const options = await node.methods.loadOptions.listSlots.call(loadOptionsContext({ wf, credentials, current: {} }) as never);
    assert.deepEqual(options.map((o) => o.value), ["support.triage"]);
    const fields = await node.methods.resourceMapping.getVariables.call(loadOptionsContext({ wf, credentials, current: { slot: "support.triage" } }) as never);
    assert.deepEqual(fields.fields.map((f) => [f.id, f.required, f.defaultValue ?? null]), [["ticket", true, null], ["team", false, "Support"]]);
  } finally {
    await server.close();
  }
});

test("Get Prompt then Report Run, as two n8n executions, with usage detected from an OpenAI-shaped item; static data keeps the copy", async () => {
  const h = harness();
  h.plane.promote([h.triage("Triage {{ticket}}", "ver_1")]);
  const server = await served(h.plane);
  const wf = workflow();
  const credentials = credentialsFor(h.plane, server.baseUrl);
  try {
    const [got] = await node.execute.call(executeContext({ wf, credentials, params: { operation: "getPrompt", slot: "support.triage", variables: { mappingMode: "defineBelow", value: { ticket: "Where is my parcel?" } }, subject: "cust-1" } }) as never);
    const item = got![0]!.json as Record<string, unknown>;
    assert.match(String(item.prompt), /Where is my parcel\?/);
    assert.equal(item.model, "gpt-5-mini");
    assert.equal(item.versionId, "ver_1");
    assert.equal(item.servedFrom, "network");
    assert.ok(Object.keys((wf.staticGlobal.airprompter as object) ?? {}).some((key) => key.includes("/releases/")), "the release is kept in workflow static data");

    const modelOutput = { message: { content: "It ships Monday" }, usage: { prompt_tokens: 321, completion_tokens: 12, total_tokens: 333 } };
    const [reported] = await node.execute.call(executeContext({ wf, credentials, items: [modelOutput], params: { operation: "reportRun", runRef: item.runRef, usageFrom: "detect", additional: { rating: 5 } } }) as never);
    const out = reported![0]!.json as { airprompter: { reported: boolean; inputTokens: number; outputTokens: number } };
    assert.deepEqual(out.airprompter.reported, true);
    assert.equal(out.airprompter.inputTokens, 321);
    assert.equal(out.airprompter.outputTokens, 12);
  } finally {
    await server.close();
  }
});

test("Get Prompt serves from workflow static data when AirPrompter is down; errors map to n8n errors; continueOnFail keeps going", async () => {
  const h = harness();
  h.plane.promote([h.triage("Triage {{ticket}}", "ver_1")]);
  const server = await served(h.plane);
  const wf = workflow();
  const credentials = credentialsFor(h.plane, server.baseUrl);
  const params = { operation: "getPrompt", slot: "support.triage", variables: { mappingMode: "defineBelow", value: { ticket: "t" } } };
  await node.execute.call(executeContext({ wf, credentials, params }) as never);
  await server.close();
  const [offline] = await node.execute.call(executeContext({ wf, credentials, params }) as never);
  assert.equal((offline![0]!.json as { servedFrom: string }).servedFrom, "stored");

  await assert.rejects(node.execute.call(executeContext({ wf, credentials, params: { ...params, slot: "missing.slot" } }) as never), (error: Error) => error.constructor.name === "NodeOperationError" && /missing\.slot/.test(error.message));
  const [soft] = await node.execute.call(executeContext({ wf, credentials, params: { ...params, variables: { mappingMode: "defineBelow", value: {} } }, continueOnFail: true }) as never);
  assert.match(String((soft![0]!.json as { error: string }).error), /ticket/);

  // A workflow that never reached AirPrompter has nothing to serve.
  await assert.rejects(node.execute.call(executeContext({ wf: workflow(), credentials, params }) as never), (error: Error) => error.constructor.name === "NodeOperationError" && /could not be reached/.test(error.message));
});

test("self-hosted storage lives under N8N_USER_FOLDER/.n8n/airprompter and is shared across workflows", async () => {
  const folder = mkdtempSync(join(tmpdir(), "ap-n8n-user-"));
  const previous = process.env.N8N_USER_FOLDER;
  process.env.N8N_USER_FOLDER = folder;
  const h = harness();
  h.plane.promote([h.triage("Triage {{ticket}}", "ver_1")]);
  const server = await served(h.plane);
  try {
    const credentials = credentialsFor(h.plane, server.baseUrl, "userFolder");
    const params = { operation: "getPrompt", slot: "support.triage", variables: { mappingMode: "defineBelow", value: { ticket: "t" } } };
    await node.execute.call(executeContext({ wf: workflow(), credentials, params }) as never);
    assert.ok(existsSync(join(folder, ".n8n", "airprompter", "agt_n8n", "prod", "releases")));
    await server.close();
    const [other] = await node.execute.call(executeContext({ wf: workflow(), credentials, params }) as never);
    assert.equal((other![0]!.json as { servedFrom: string }).servedFrom, "stored", "another workflow serves the same stored copy");
  } finally {
    if (previous === undefined) delete process.env.N8N_USER_FOLDER;
    else process.env.N8N_USER_FOLDER = previous;
    rmSync(folder, { recursive: true, force: true });
  }
});

test("Trigger: baseline first, then one item per rollout change, deduped across replays; filters by event and slot", async () => {
  const h = harness();
  const v1 = h.triage("v1 {{ticket}}", "ver_1", 1);
  h.plane.promote([v1]);
  const server = await served(h.plane);
  const wf = workflow();
  const credentials = credentialsFor(h.plane, server.baseUrl);
  const poll = (params: Record<string, unknown> = {}, mode: "trigger" | "manual" = "trigger") => trigger.poll.call(pollContext({ wf, credentials, params, mode }) as never);
  const states = (result: Awaited<ReturnType<typeof poll>>) => (result ? result[0]!.map((i) => (i.json as { state: string }).state) : null);
  try {
    assert.equal(await poll(), null, "first poll records the baseline");
    const manual = await poll({}, "manual");
    assert.deepEqual(states(manual), ["current"], "a manual test shows the current state");
    assert.equal(await poll(), null);

    const v2 = h.triage("v2 {{ticket}}", "ver_2", 2);
    h.plane.promote([v2]);
    const snapshot = JSON.parse(JSON.stringify(wf.staticNode)) as IDataObject;
    const fired = await poll();
    assert.deepEqual(states(fired), ["new_version"]);
    assert.match(String((fired![0]![0]!.json as { summary: string }).summary), /ver_1 → ver_2/);
    assert.equal(await poll(), null, "fires once");

    // A replay from a cursor that missed the last save fires nothing new for the same change.
    wf.staticNode.cursor = snapshot.cursor;
    assert.equal(await poll(), null, "a replayed change is deduped");

    h.plane.promote([v2], { experiments: [abTest(h, v2, h.triage("v3 {{ticket}}", "ver_3", 3), [9000, 1000])] });
    assert.equal(await poll({ events: ["rolled_back"] }), null, "filtered out by event");
    h.plane.promote([h.triage("v1 {{ticket}}", "ver_1", 1)]);
    const rollback = await poll({ events: ["rolled_back"], slots: ["support.triage"] });
    assert.deepEqual(rollback![0]!.map((i) => [(i.json as { state: string }).state, (i.json as { versionId: string }).versionId]), [["rolled_back", "ver_1"]]);
  } finally {
    await server.close();
  }
});
