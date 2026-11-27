#!/usr/bin/env node
/**
 * A smoke test of the live-run kit with no AirPrompter and no network: the SDK's fake control plane (the one the
 * unit tests use) on loopback, with one promoted slot, and `scripts/live-n8n.mjs` run against it. For an image build,
 * so a broken n8n, wrapper or prepared folder fails the build rather than a QA run. Arguments pass through to the
 * kit, so `--nodes-dir <folder>` exercises the offline path the image uses. It needs this package's dev dependencies
 * (`npm ci --legacy-peer-deps`; the fake plane is `@airprompter/agent-sdk/testing`) and N8N_BIN.
 *
 * It prints the kit's JSON line, plus `smoke` (the fake slot's expected rendered text sha256, and whether the kit's
 * `getPrompt.promptSha256` equals it), and exits with the kit's code, or 1 when the rendered text is not the slot's.
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

import { publicJwkOf } from "@airprompter/agent-sdk/core";
import { FakeControlPlane, serveOverHttp } from "@airprompter/agent-sdk/testing";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "live-n8n.mjs");
const TEXT = "Route this ticket: {{ticket}}";
const TICKET = "Refund for order 1042 has not arrived";

const plane = new FakeControlPlane({ organizationId: "org_smoke", agentId: "agent_smoke", target: "prod" });
plane.now = () => Date.now();
plane.promote([plane.slot({ tag: "triage", text: TEXT, versionId: "ver_smoke", model: "gpt-5-mini", variables: [{ name: "ticket", required: true, trust: "operator" }] })]);
const server = await serveOverHttp(plane, { port: 0 });
// The upload grant's fake bucket sits behind the same listener, so Report Run is accepted end to end.
plane.grantBaseUrl = server.baseUrl;

const child = spawn(process.execPath, [KIT, ...process.argv.slice(2)], {
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
  },
});
let stdout = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
const code = await new Promise((done) => child.on("close", (status) => done(status ?? 1)));
await server.close();

let summary = null;
try {
  summary = JSON.parse(stdout.trim().split("\n").pop() || "null");
} catch {
  summary = null;
}
// An operator-trust variable is substituted as is: the text the node should have rendered.
const expectedSha256 = createHash("sha256").update(TEXT.replace("{{ticket}}", TICKET), "utf8").digest("hex");
const renderedMatches = summary?.getPrompt?.promptSha256 === expectedSha256;
process.stdout.write(`${JSON.stringify({ ...(summary ?? { ok: false, error: "the kit printed no JSON" }), smoke: { expectedPromptSha256: expectedSha256, renderedMatches } })}\n`);
process.exit(code !== 0 ? code : renderedMatches ? 0 : 1);
