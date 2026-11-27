/**
 * The README's quick start, run as written against the fake control plane: it must reach an approved, verified render,
 * so the docs cannot drift from the code. The block is read out of `README.md` on every run.
 *
 * Three things in it cannot run verbatim, and each is replaced by exact text, once: the two id placeholders (`"org_…"`,
 * `"agt_…"`) and AirPrompter's production root key, because the fake cannot sign as AirPrompter. The key is first
 * checked to BE the production root (`HOSTED_ROOTS.prod`), and the fake's key then stands in for it in that table, so
 * the default the README relies on (root.json from `https://api.airprompter.com/roots/prod/root.json`) is the path
 * taken. The start options the block builds reach `AirPrompterAgent.start` unchanged; the test adds only where the
 * process runs: the fake's `fetch`, a temporary `stateDir`, a memory spool and a logger.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent, type StartOptions } from "../packages/sdk/src/agent.js";
import { HOSTED_ROOTS, publicJwkOf } from "../packages/sdk/src/core/index.js";
import { FakeControlPlane } from "./helpers/controlPlane.js";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const IMPORT = 'import { AirPrompterAgent } from "@airprompter/agent-sdk";';
const ROOT_LITERAL = /root: \{ pinned: (\{[^{}]*\}) \}/;
const PROD_ROOT = HOSTED_ROOTS.prod!;

/** The first ```ts block under "## Quick start". */
function quickStart(): string {
  const section = README.split("\n## Quick start\n")[1];
  assert.ok(section, "README.md has a Quick start section");
  const block = /^```ts\n([\s\S]*?)\n```$/m.exec(section.split("\n## ")[0]!);
  assert.ok(block, "the Quick start has a ts block");
  return block[1]!;
}

function once(text: string, find: string, replace: string): string {
  assert.equal(text.split(find).length - 1, 1, `the quick start has ${JSON.stringify(find)} exactly once`);
  return text.replace(find, () => replace);
}

test("the README quick start pins AirPrompter's production root, and starts with nothing else to configure", () => {
  const code = quickStart();
  const literal = ROOT_LITERAL.exec(code);
  assert.ok(literal, "the quick start pins a root key inline");
  assert.deepEqual(new Function(`return (${literal[1]});`)(), PROD_ROOT, "the key shown is HOSTED_ROOTS.prod, byte for byte");
  assert.doesNotMatch(code, /rootUrl|hostedEnvironment|baseUrl/, "the hosted default is what the quick start relies on");
  assert.doesNotMatch(code, /…\/|<token>/, "no URL placeholder a reader would have to fill");
});

test("the README quick start, run as written, serves the approved release, verified through the default root URL", async () => {
  const plane = new FakeControlPlane({ organizationId: "org_quickstart", agentId: "agt_quickstart", target: "prod" });
  plane.promote([
    plane.slot({
      tag: "support.triage",
      text: "Route this {{ticket}} to {{team}}.",
      model: "gpt-5",
      versionId: "ver_triage_approved",
      variables: [{ name: "team", required: true, trust: "operator" }, { name: "ticket", required: true, trust: "end_user" }],
    }),
  ]);
  const code = quickStart();
  const literal = ROOT_LITERAL.exec(code)![1]!;
  let body = once(code, IMPORT, "");
  assert.doesNotMatch(body, /^\s*import\b/m, "the block imports only the agent");
  body = once(body, '"org_…"', JSON.stringify(plane.scope.organizationId));
  body = once(body, '"agt_…"', JSON.stringify(plane.scope.agentId));
  body = once(body, literal, JSON.stringify(publicJwkOf(plane.rootKey)));

  const stateDir = mkdtempSync(join(tmpdir(), "ap-readme-"));
  const events: Array<Record<string, unknown>> = [];
  const calls: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
  let asWritten: StartOptions | null = null;
  const agentAsImported = {
    start: (options: StartOptions) => {
      asWritten = options;
      return AirPrompterAgent.start({ ...options, fetch: plane.fetch(), stateDir, telemetry: { sink: "memory" }, logger: (event) => void events.push(event) });
    },
  };
  const openai = {
    chat: {
      completions: {
        create: async (request: (typeof calls)[number]) => {
          calls.push(request);
          return { id: "chatcmpl_1", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Billing has it." } }], usage: { prompt_tokens: 40, completion_tokens: 5 } };
        },
      },
    },
  };
  // The fake's root stands in for AirPrompter's production root, so the agent takes the hosted default.
  HOSTED_ROOTS.prod = publicJwkOf(plane.rootKey);
  let ap: AirPrompterAgent | null = null;
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<{ ap: AirPrompterAgent; r: { text: string; versionId: string; generation: number; model: string } }>;
    const run = new AsyncFunction("AirPrompterAgent", "process", "openai", "userMessage", `${body}\nreturn { ap, r };`);
    const out = await run(agentAsImported, { env: { AIRPROMPTER_AGENT_KEY: plane.apiKey } }, openai, "Where is my refund?");
    ap = out.ap;
    assert.ok(asWritten, "the block started the agent");
    assert.equal((asWritten as StartOptions).sync?.rootUrl, undefined, "no root URL was given: the default carried it");

    // An approved render, not a passthrough: the promoted version, its text, at generation 1.
    assert.equal(out.r.versionId, "ver_triage_approved");
    assert.equal(out.r.generation, 1);
    assert.equal(out.r.model, "gpt-5");
    assert.equal(out.r.text, "Route this <ticket>Where is my refund?</ticket> to Billing.");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.messages[0]!.content, out.r.text, "the provider was sent the approved text");
    assert.equal(ap.status().generation, 1);

    // The signing keys came from the hosted root URL, and only from there.
    assert.ok(plane.requests.includes("https://api.airprompter.com/roots/prod/root.json"), plane.requests.join("\n"));
    assert.deepEqual(plane.requests.filter((url) => url.endsWith("/root.json")).filter((url, i, all) => all.indexOf(url) === i), ["https://api.airprompter.com/roots/prod/root.json"]);
    assert.ok(events.some((e) => e.event === "root_url_default" && e.environment === "prod" && e.rootUrl === "https://api.airprompter.com/roots/prod/root.json"));
    assert.ok(!events.some((e) => e.reason === "unknown_signing_key"), "every manifest verified");
  } finally {
    HOSTED_ROOTS.prod = PROD_ROOT;
    await ap?.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
