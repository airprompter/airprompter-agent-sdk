/**
 * The README's quick start, run as written against the fake control plane: it must type-check against the SDK and
 * reach an approved, verified render, so the docs cannot drift from the code. The block is read out of `README.md` on
 * every run, and it is the section's only code block.
 *
 * Three things in it cannot run verbatim, and each is replaced by exact text, once: the two id placeholders (`"org_…"`,
 * `"agt_…"`) and AirPrompter's production root key, because the fake cannot sign as AirPrompter. The key is first
 * checked to BE the production root (`HOSTED_ROOTS.prod`), and the fake's key is then recognised as the hosted prod
 * root (`withHostedRootsForTests`), so the default the README relies on (root.json from
 * `https://api.airprompter.com/roots/prod/root.json`) is the path taken. The start options the block builds reach
 * `AirPrompterAgent.start` unchanged; the test adds only where the process runs (the fake's `fetch`, a temporary
 * `stateDir`, a memory spool, a logger), and the block may set none of those itself. `openai` and `userMessage` are
 * the application's own, declared for the type check and faked for the run.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { AirPrompterAgent, type StartOptions } from "../packages/sdk/src/agent.js";
import { HOSTED_ROOTS, publicJwkOf } from "../packages/sdk/src/core/index.js";
import { withHostedRootsForTests } from "../packages/sdk/src/core/protocol/hostedRoots.js";
import { FakeControlPlane } from "./helpers/controlPlane.js";

// A Windows checkout may carry CRLF line ends.
const README = readFileSync(new URL("../README.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const IMPORT = 'import { AirPrompterAgent } from "@airprompter/agent-sdk";';
const ROOT_LITERAL = /root: \{ pinned: (\{[^{}]*\}) \}/;
const PROD_ROOT = HOSTED_ROOTS.prod!;
const PROD_URL = "https://api.airprompter.com/roots/prod/root.json";
/** What the application supplies around the block: its OpenAI client and the user's message. */
const APP_DECLARATIONS = `
declare const openai: { chat: { completions: { create(request: { model: string; messages: Array<{ role: "system" | "user" | "assistant"; content: string }> }): Promise<{ usage?: { prompt_tokens: number; completion_tokens: number } }> } } };
declare const userMessage: string;
export {};
`;

/** The only code block under "## Quick start", a ts one. */
function quickStart(): string {
  const section = README.split("\n## Quick start\n")[1]?.split(/\n#{2,} /)[0]; // up to the next heading of any level
  assert.ok(section, "README.md has a Quick start section");
  assert.equal(section.match(/^```/gm)?.length, 2, "the Quick start has exactly one code block");
  const block = /^```ts\n([\s\S]*?)\n```$/m.exec(section);
  assert.ok(block, "the Quick start's block is ts");
  return block[1]!;
}

function once(text: string, find: string, replace: string): string {
  assert.equal(text.split(find).length - 1, 1, `the quick start has ${JSON.stringify(find)} exactly once`);
  return text.replace(find, () => replace);
}

function shownRoot(code: string): P256Literal {
  const literal = ROOT_LITERAL.exec(code);
  assert.ok(literal, "the quick start pins a root key inline");
  return { text: literal[1]!, value: new Function(`return (${literal[1]});`)() };
}
type P256Literal = { text: string; value: unknown };

test("the README quick start pins AirPrompter's production root and configures nothing else about trust or sync endpoints", () => {
  const code = quickStart();
  assert.deepEqual(shownRoot(code).value, PROD_ROOT, "the key shown is HOSTED_ROOTS.prod, byte for byte");
  assert.doesNotMatch(code, /rootUrl|hostedEnvironment|baseUrl|edgePointerUrl/, "the hosted defaults are what the quick start relies on");
  assert.doesNotMatch(code, /…\/|<token>/, "no URL placeholder a reader would have to fill");
});

test("the README quick start type-checks against the SDK, as written", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const configPath = join(here, "..", "tsconfig.json");
  const config = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, dirname(configPath));
  // TypeScript names files with forward slashes on every platform (D:/a/… on Windows).
  const virtual = join(here, "readme-quick-start.virtual.ts").replace(/\\/g, "/");
  const isVirtual = (name: string) => name.replace(/\\/g, "/") === virtual;
  const source = `${quickStart()}\n${APP_DECLARATIONS}`;
  const host = ts.createCompilerHost(config.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, ...rest) => (isVirtual(name) ? ts.createSourceFile(name, source, version) : getSourceFile(name, version, ...rest));
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => isVirtual(name) || fileExists(name);
  // The repository compiles with exactOptionalPropertyTypes; a customer project, like the TypeScript default, does not.
  const program = ts.createProgram({ rootNames: [virtual], options: { ...config.options, noEmit: true, exactOptionalPropertyTypes: false }, host });
  const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(virtual)).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  assert.deepEqual(diagnostics, []);
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
  const root = shownRoot(code);
  assert.deepEqual(root.value, PROD_ROOT, "the key the run stands the fake in for is AirPrompter's production root");
  let body = once(code, IMPORT, "");
  assert.doesNotMatch(body, /^\s*import\b/m, "the block imports only the agent");
  body = once(body, '"org_…"', JSON.stringify(plane.scope.organizationId));
  body = once(body, '"agt_…"', JSON.stringify(plane.scope.agentId));
  body = once(body, root.text, JSON.stringify(publicJwkOf(plane.rootKey)));

  const stateDir = mkdtempSync(join(tmpdir(), "ap-readme-"));
  const events: Array<Record<string, unknown>> = [];
  const calls: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
  let asWritten: StartOptions | null = null;
  const added = { fetch: plane.fetch(), stateDir, telemetry: { sink: "memory" as const }, logger: (event: Record<string, unknown>) => void events.push(event) };
  const agentAsImported = {
    start: (options: StartOptions) => {
      asWritten = options;
      for (const key of Object.keys(added)) assert.ok(!(key in options), `the quick start sets ${key}, which this test supplies`);
      return AirPrompterAgent.start({ ...options, ...added });
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
  let ap: AirPrompterAgent | null = null;
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<{ ap: AirPrompterAgent; r: { text: string; versionId: string; generation: number; model: string } }>;
    // Types stripped first, so TypeScript-only syntax the type check accepts runs too.
    const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^export \{\};\s*$/m, "");
    const run = new AsyncFunction("AirPrompterAgent", "process", "openai", "userMessage", `${js}\nreturn { ap, r };`);
    // The fake's root is recognised as AirPrompter's prod root, so the agent takes the hosted default.
    const out = await withHostedRootsForTests({ ...HOSTED_ROOTS, prod: publicJwkOf(plane.rootKey) }, () => run(agentAsImported, { env: { AIRPROMPTER_AGENT_KEY: plane.apiKey } }, openai, "Where is my refund?"));
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
    assert.deepEqual([...new Set(plane.requests.filter((url) => url.endsWith("/root.json")))], [PROD_URL]);
    assert.ok(events.some((e) => e.event === "root_url_default" && e.environment === "prod" && e.rootUrl === PROD_URL));
    assert.ok(!events.some((e) => e.reason === "unknown_signing_key"), "every manifest verified");
  } finally {
    await ap?.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
