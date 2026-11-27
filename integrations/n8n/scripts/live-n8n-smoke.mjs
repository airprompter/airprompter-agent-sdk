#!/usr/bin/env node
/**
 * A smoke test of the live-run kit with no AirPrompter: the SDK's fake control plane (the one the unit tests use) on
 * loopback with one promoted slot, and `scripts/live-n8n.mjs` run against it. For an image build, so a broken n8n,
 * wrapper or prepared folder fails the build rather than a QA run. Arguments pass through to the kit: with
 * `--nodes-dir <folder>` it exercises the offline path the image uses and needs no network at all (without it the
 * kit packs and installs, which reaches the npm registry). It needs N8N_BIN and this package's installed
 * dependencies (`npm ci --legacy-peer-deps`, in the same image stage: the fake plane is `@airprompter/agent-sdk/testing`).
 * The fake plane signs with its own root (AIRPROMPTER_ROOT_KEY), so the pinned dev root is not exercised here.
 *
 * It passes only when the kit exits 0 with every check `pass` (none skipped), including `get_prompt.rendered` (the
 * expected text's sha256 is set for it), and when the fake plane received exactly one counted run on `ver_smoke`
 * with 123 input and 7 output tokens. It prints one JSON line every time: the kit's, with `ok`/`exitCode` set to
 * the smoke's verdict and a `smoke` object (`problems` lists what failed), and exits 0 or 1 (2: bad input; 130 or
 * 143 when interrupted, after the kit has stopped).
 * SMOKE_TIMEOUT_MS (default 900000) kills the kit's whole process group if it hangs.
 *
 * @example
 * ```sh
 * N8N_BIN=/opt/n8n/n8n AIRPROMPTER_KIT_COMMIT=<sha> node scripts/live-n8n-smoke.mjs --nodes-dir /opt/airprompter/n8n-nodes
 * ```
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "live-n8n.mjs");
const TEXT = "Route this ticket: {{ticket}}";
const TICKET = "Refund for order 1042 has not arrived";
const VERSION = "ver_smoke";
const startedAt = new Date().toISOString();
const say = (verdict) => process.stdout.write(`${JSON.stringify(verdict)}\n`);

if (!process.env.N8N_BIN?.trim()) {
  say({ ok: false, exitCode: 2, startedAt, error: "set N8N_BIN: the smoke never falls back to npx" });
  process.exit(2);
}

let server = null;
let child = null;
let interrupted = null;
const stop = (signal) => {
  if (child?.pid) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* already gone */
    }
  }
};
// Forward to the kit's whole process group and let the normal path wait for it, close the server and print the line.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = signal;
    stop(signal);
  });
}

let verdict;
try {
  const { publicJwkOf } = await import("@airprompter/agent-sdk/core");
  const { FakeControlPlane, serveOverHttp } = await import("@airprompter/agent-sdk/testing");
  const plane = new FakeControlPlane({ organizationId: "org_smoke", agentId: "agent_smoke", target: "prod" });
  plane.promote([plane.slot({ tag: "triage", text: TEXT, versionId: VERSION, model: "gpt-5-mini", variables: [{ name: "ticket", required: true, trust: "operator" }] })]);
  server = await serveOverHttp(plane, { port: 0 });
  // The upload grant's fake bucket and the edge pointer sit behind the same listener: nothing leaves loopback (the
  // fake's default edge is https://edge.test, which a permissive resolver would try).
  plane.grantBaseUrl = server.baseUrl;
  plane.edgePointerUrl = `${server.baseUrl}/g/target-token/generation.json`;
  // An operator-trust variable is substituted as is: the text the node must render. A function, so `$` is literal.
  const expectedPromptSha256 = createHash("sha256").update(TEXT.replaceAll("{{ticket}}", () => TICKET), "utf8").digest("hex");

  const problemsAtSpawn = [];
  // Its own process group, so a timeout or an interrupt reaches n8n and its task runner too.
  child = spawn(process.execPath, [KIT, ...process.argv.slice(2)], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      ...process.env,
      AIRPROMPTER_AGENT_ID: plane.scope.agentId,
      AIRPROMPTER_UPDATE_KEY: plane.apiKey,
      AIRPROMPTER_ENVIRONMENT: "prod",
      AIRPROMPTER_API_URL: server.baseUrl,
      AIRPROMPTER_DEPLOYMENT: "prod",
      AIRPROMPTER_ROOT_KEY: JSON.stringify(publicJwkOf(plane.rootKey)),
      AIRPROMPTER_SLOT: "triage",
      AIRPROMPTER_VARIABLES: JSON.stringify({ ticket: TICKET }),
      AIRPROMPTER_EXPECTED_PROMPT_SHA256: expectedPromptSha256,
    },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 900_000);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop("SIGKILL");
  }, timeoutMs);
  const code = await new Promise((done) => {
    child.on("error", (error) => {
      problemsAtSpawn.push(`the kit could not start: ${error.message}`);
      done(1);
    });
    child.on("close", (status) => done(status ?? 1));
  });
  clearTimeout(timer);

  let summary = null;
  try {
    summary = JSON.parse(stdout.trim().split("\n").pop() || "null");
  } catch {
    summary = null;
  }
  // What the fake bucket received: window rows, one per run window, `count` runs each.
  const rows = [...plane.objects.values()].flatMap((body) => {
    const text = (body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body).toString("utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  });
  const windows = rows.filter((row) => row.type === "window" && row.count > 0);
  const delivered = { runs: windows.reduce((sum, row) => sum + row.count, 0), versionIds: [...new Set(windows.map((row) => row.versionId))], inputTokens: windows.reduce((sum, row) => sum + (row.tokens?.input ?? 0), 0), outputTokens: windows.reduce((sum, row) => sum + (row.tokens?.output ?? 0), 0) };

  const problems = [...problemsAtSpawn];
  if (interrupted) problems.push(`interrupted (${interrupted})`);
  if (timedOut) problems.push(`the kit did not finish within ${timeoutMs} ms and was killed`);
  if (!summary) problems.push("the kit printed no JSON");
  if (code !== 0) problems.push(`the kit exited ${code}${summary?.error ? `: ${summary.error}` : ""}`);
  const notPassed = (summary?.checks ?? []).filter((entry) => entry.state !== "pass").map((entry) => `${entry.id}=${entry.state}`);
  if (notPassed.length) problems.push(`checks not passed: ${notPassed.join(", ")}`);
  if (summary && !(summary.checks ?? []).some((entry) => entry.id === "get_prompt.rendered")) problems.push("the kit did not run get_prompt.rendered");
  if (process.argv.slice(2).some((arg) => arg === "--nodes-dir" || arg.startsWith("--nodes-dir=")) && summary?.nodes?.mode !== "preinstalled") problems.push("--nodes-dir given but the kit did not use the prepared folder");
  if (summary?.getPrompt && (summary.getPrompt.versionId !== VERSION || summary.getPrompt.servedFrom !== "network")) problems.push(`Get Prompt served ${summary.getPrompt.versionId} from ${summary.getPrompt.servedFrom}, not ${VERSION} from network`);
  if (delivered.runs !== 1 || delivered.versionIds.join() !== VERSION || delivered.inputTokens !== 123 || delivered.outputTokens !== 7) problems.push(`the fake plane received ${JSON.stringify(delivered)}, not exactly one run on ${VERSION} with 123/7 tokens`);
  const ok = problems.length === 0;
  verdict = { ...(summary ?? {}), ok, exitCode: interrupted ? (interrupted === "SIGINT" ? 130 : 143) : ok ? 0 : 1, smoke: { expectedPromptSha256, delivered, problems, kitExitCode: code } };
} catch (error) {
  verdict = { ok: false, exitCode: 1, startedAt, error: `the smoke could not run: ${error.message}` };
} finally {
  await server?.close().catch(() => undefined);
}
say(verdict);
process.exit(verdict.exitCode);
