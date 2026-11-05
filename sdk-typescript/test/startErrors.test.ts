/**
 * What a customer reads when nothing could be served or the control plane refuses a call. A start with nothing to
 * serve carries on, and `started_without_release` names the control plane's answer (404 nothing promoted, 401 key,
 * 403 code, transport error) instead of "nothing could be fetched";
 * `heartbeat_refused` carries the server's message and validation issues; a wrong `options.sdk` is refused at start,
 * before any network, since the heartbeat schema would refuse every beat after.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent, AgentStartError, HEARTBEAT_REPORTER_NAMES } from "../packages/sdk/src/agent.js";
import { publicJwkOf } from "../packages/sdk/src/core/protocol/trust.js";
import { FakeControlPlane } from "./helpers/controlPlane.js";

const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };
const tempDir = () => mkdtempSync(join(tmpdir(), "ap-start-errors-"));

function options(plane: FakeControlPlane, extra: Partial<Parameters<typeof AirPrompterAgent.start>[0]> = {}) {
  return {
    ...scope,
    apiKey: plane.apiKey,
    baseUrl: "https://api.test",
    stateDir: tempDir(),
    root: { pinned: publicJwkOf(plane.rootKey) },
    sync: { mode: "resident" as const, pollSeconds: 3600, rootUrl: "https://edge.test/roots/prod/root.json" },
    fetch: plane.fetch(),
    ...extra,
  };
}

async function startError(input: Parameters<typeof AirPrompterAgent.start>[0]): Promise<AgentStartError> {
  try {
    const agent = await AirPrompterAgent.start(input);
    await agent.stop();
  } catch (error) {
    assert.ok(error instanceof AgentStartError, `expected AgentStartError, got ${String(error)}`);
    return error;
  }
  assert.fail("start succeeded");
}

async function startLog(input: Parameters<typeof AirPrompterAgent.start>[0]): Promise<string> {
  const events: Array<Record<string, unknown>> = [];
  const agent = await AirPrompterAgent.start({ ...input, logger: (event) => events.push(event) });
  assert.equal(agent.generation, 0);
  await agent.stop();
  const line = events.find((event) => event.event === "started_without_release");
  assert.ok(line, "started_without_release was logged");
  return line.reason as string;
}

test("started_without_release names the control plane's answer: nothing promoted is a 404 with the fix in the sentence", async () => {
  const plane = new FakeControlPlane(scope);
  const reason = await startLog(options(plane));
  assert.match(reason, /no release promoted to prod for agt_1 on prod \(HTTP 404\)/);
  assert.match(reason, /promote one from the app's board/);
  assert.match(reason, /bound to this app and environment/);
});

test("started_without_release names a refused key (401) and a forbidden read (403 with the server's code)", async () => {
  const plane = new FakeControlPlane(scope);
  const unauthorized = await startLog(options(plane, { apiKey: "apa_prod_not-this-key" }));
  assert.match(unauthorized, /refused this key for agt_1 on prod \(HTTP 401\)/);
  assert.match(unauthorized, /wrong, revoked, or minted for another environment/);

  const forbidden = await startLog(options(plane, { agentId: "agt_other" }));
  assert.match(forbidden, /forbade the read for agt_other on prod \(HTTP 403 agent_mismatch\)/);
});

test("started_without_release names a transport failure with the base URL and the error", async () => {
  const plane = new FakeControlPlane(scope);
  const reason = await startLog(
    options(plane, {
      baseUrl: "https://api.unreachable.test",
      fetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND api.unreachable.test");
      },
    }),
  );
  assert.match(reason, /api\.unreachable\.test could not be reached: getaddrinfo ENOTFOUND api\.unreachable\.test/);
});

test("options.sdk is the reporter's name, checked at start: a customer's app name is refused before any network call", async () => {
  const plane = new FakeControlPlane(scope);
  let calls = 0;
  const error = await startError(
    options(plane, {
      fetch: async (...args: Parameters<ReturnType<FakeControlPlane["fetch"]>>) => {
        calls += 1;
        return plane.fetch()(...args);
      },
      sdk: { name: "acme-support-bot", version: "0.1.0" } as unknown as { name: "agent-sdk-typescript"; version: string },
    }),
  );
  assert.equal(error.code, "invalid_options");
  assert.match(error.message, /options\.sdk names the reporting software/);
  assert.match(error.message, /agent-sdk-typescript, agent-sdk-python, airprompter-cli, airprompterd/);
  assert.match(error.message, /not the place for your app's name/);
  assert.equal(calls, 0, "refused before any network call");
  assert.deepEqual([...HEARTBEAT_REPORTER_NAMES], ["agent-sdk-typescript", "agent-sdk-python", "airprompter-cli", "airprompterd"]);
  // A valid reporter with an over-long version is refused the same way.
  const long = await startError(options(plane, { sdk: { name: "airprompter-cli", version: "v".repeat(65) } }));
  assert.equal(long.code, "invalid_options");
});

test("heartbeat_refused carries the control plane's message and validation issues, bounded", async () => {
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply politely.", variables: [] })]);
  const events: Record<string, unknown>[] = [];
  const agent = await AirPrompterAgent.start(options(plane, { logger: (event) => events.push(event) }));
  await agent.heartbeatNow(); // the boot heartbeat, accepted; the next one is the refused one
  plane.heartbeatRefusal = {
    status: 400,
    code: null,
    message: "The heartbeat body does not match the protocol",
    issues: Array.from({ length: 12 }, (_, i) => ({ path: `field${i}`, message: `issue ${i}` })),
  };
  await agent.heartbeatNow();
  const refused = events.find((event) => event.event === "heartbeat_refused");
  assert.ok(refused, "heartbeat_refused was logged");
  assert.equal(refused.httpStatus, 400);
  assert.equal(refused.message, "The heartbeat body does not match the protocol");
  assert.equal((refused.issues as unknown[]).length, 8, "issues are bounded to eight");
  assert.deepEqual((refused.issues as Array<{ path: string; message: string }>)[0], { path: "field0", message: "issue 0" });

  // A refusal with a code and no issues (the existing shape) logs the code and the message; no empty issues key.
  events.length = 0;
  plane.heartbeatRefusal = { status: 403, code: "instance_cap_reached" };
  await agent.heartbeatNow();
  const capped = events.find((event) => event.event === "heartbeat_refused");
  assert.equal(capped?.code, "instance_cap_reached");
  assert.equal("issues" in (capped ?? {}), false);
  await agent.stop();
});


test("S18: the pinned root is scoped to the HOSTED environment, not the app's target — a staging app on the dev deployment verifies with the dev root; the target-scoped mistake was unknown_signing_key", async () => {
  // The dev deployment signs every target's manifests with its one platform key; its root document says environment "dev".
  const staging = { organizationId: "org_1", agentId: "agt_1", target: "staging" as const };
  const plane = new FakeControlPlane(staging, "apa_live_testkey", {}, { hostedEnvironment: "dev" });
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply politely.", variables: [] })]);
  const agent = await AirPrompterAgent.start({ ...options(plane, { ...staging, root: { pinned: publicJwkOf(plane.rootKey), hostedEnvironment: "dev" }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/dev/root.json" } }) });
  assert.equal(agent.generation, 1);
  assert.equal(agent.prompt("support.reply").render({}).text, "Reply politely.");
  await agent.stop();
  // The same app with the root scoped to its target (the old default) cannot accept the dev root document and never trusts the signing key.
  const wrong = await startLog({ ...options(plane, { ...staging, root: { pinned: publicJwkOf(plane.rootKey), hostedEnvironment: "staging" }, sync: { mode: "resident", pollSeconds: 3600, rootUrl: "https://edge.test/roots/dev/root.json" } }) });
  assert.match(wrong, /unknown_signing_key/);
});

test("nothing promoted now starts: a promotion plus syncNow then serves with no restart", async () => {
  const plane = new FakeControlPlane(scope);
  const agent = await AirPrompterAgent.start(options(plane));
  assert.equal(agent.generation, 0);
  assert.throws(() => agent.prompt("support.reply").render({}), (error: unknown) => error instanceof AgentStartError && error.code === "no_verified_release");
  const before = await agent.run({ subject: "ann" }, (run) => run.place("support.reply"));
  assert.deepEqual(before, { kind: "passthrough", slot: "support.reply", reason: "no_verified_release" });

  plane.promote([plane.slot({ tag: "support.reply", text: "Reply politely.", variables: [] })]);
  await agent.syncNow();
  assert.equal(agent.generation, 1);
  assert.equal(agent.prompt("support.reply").render({}).text, "Reply politely.");
  const after = await agent.run({ subject: "ann" }, (run) => run.place("support.reply"));
  assert.equal(after.kind === "approved" && after.instructions, "Reply politely.");
  await agent.stop();
});

test("unlock_required stays passthrough until unlock()", async () => {
  const plane = new FakeControlPlane(scope);
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply politely.", variables: [] })], { applyPolicy: "unlock_required" });
  const agent = await AirPrompterAgent.start(options(plane));
  const waiting = await agent.run({ subject: "ann" }, (run) => run.place("support.reply"));
  assert.deepEqual(waiting, { kind: "passthrough", slot: "support.reply", reason: "awaiting_unlock" });
  await agent.unlock();
  const served = await agent.run({ subject: "ann" }, (run) => run.place("support.reply"));
  assert.equal(served.kind, "approved");
  await agent.stop();
});

test("a store whose key cannot be read still throws: starting without a release is not starting without a store", async () => {
  const plane = new FakeControlPlane(scope);
  const unavailable = { wrap: async () => { throw new Error("kms down"); }, unwrap: async () => { throw new Error("kms down"); } };
  await assert.rejects(AirPrompterAgent.start(options(plane, { keyProvider: unavailable as never })), (error: unknown) => (error as { code?: string }).code === "kek_unavailable");
});
