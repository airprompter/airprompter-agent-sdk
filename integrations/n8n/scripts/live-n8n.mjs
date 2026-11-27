#!/usr/bin/env node
/**
 * Runs this package in a real, headless n8n against a live AirPrompter (dev by default) and checks what came back.
 * It is the repeatable proof for AIR-2393 and the driver the n8n QA test calls. It writes one counted run (Report
 * Run) and the agent's normal check-ins to AirPrompter, nothing else. `qa/README.md` says how to use it in a test.
 *
 * What it does, in a temporary folder it deletes afterwards:
 * 1. `npm run build`, then `npm pack`: the files `npm publish` would ship.
 * 2. Installs that tarball where n8n keeps community packages (`<user folder>/.n8n/nodes`), with npm flags like
 *    n8n's own installer: production dependencies only, peers from n8n. n8n loads it from there at start, with the
 *    node types a customer's workflows use (`n8n-nodes-airprompter.airPrompter`).
 * 3. Starts n8n on a fresh user folder (SQLite) and imports one credential and `qa/workflows/*.json`.
 * 4. Runs them with `n8n execute-batch` and no retries, because a retried Report Run would be counted twice:
 *    - get-prompt-report-run: Get Prompt → model stub (OpenAI-shaped usage, 123 in / 7 out) → Report Run (thumbs up)
 *    - get-prompt-unreported: Get Prompt only. It must not be counted; the caller checks that in Metrics.
 *    - get-prompt-stored-copy: Get Prompt with every outbound request failing (AirPrompter and its edge both
 *      unreachable), in an n8n of its own, served from the copy the first run stored.
 * 5. Prints one JSON line on stdout, every time. Progress and PASS/FAIL lines go to stderr.
 *    Exit 0: every check passed. 1: a check failed, or n8n could not run (`error`). 2: bad input. 130: interrupted.
 *
 * Environment (the Update key is read from the environment only, never from an argument):
 *   AIRPROMPTER_AGENT_ID      required   the agent
 *   AIRPROMPTER_UPDATE_KEY    required   an Update key bound to that agent and AIRPROMPTER_ENVIRONMENT
 *   AIRPROMPTER_ENVIRONMENT   dev        the agent environment the key and the promoted release are bound to
 *   AIRPROMPTER_API_URL       https://api.airprompter.dev
 *   AIRPROMPTER_DEPLOYMENT    dev        the deployment that signs releases (this version pins the dev root)
 *   AIRPROMPTER_ROOT_KEY      empty      the root JWK, for a deployment this version does not pin (prod, a local registry)
 *   AIRPROMPTER_SLOT          triage     the slot tag
 *   AIRPROMPTER_VARIABLES     {"ticket":"Refund for order 1042 has not arrived"}   the slot's variables, a JSON object
 *   AIRPROMPTER_SUBJECT       qa-n8n-subject-1   the A/B subject, so the arm is the same on every run
 *   N8N_VERSION               2.49.8     the n8n this kit is proven on; another version fails the n8n.version check
 *   N8N_BIN                   empty      an n8n binary to use instead of `npx --yes n8n@$N8N_VERSION`
 * Flags: --keep (leave the folder, without the n8n encryption key, for debugging), --no-build, --any-n8n.
 *
 * @example
 * ```sh
 * AIRPROMPTER_AGENT_ID=agent_… AIRPROMPTER_UPDATE_KEY=apa_… node scripts/live-n8n.mjs
 * # {"ok":true,"exitCode":0,"getPrompt":{"versionId":"…","servedFrom":"network",…},"expected":{"runs":1,…},…}
 * ```
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = join(PACKAGE_DIR, "qa", "workflows");
const NODE_TYPE = "n8n-nodes-airprompter.airPrompter";
const CREDENTIAL_ID = "apQaCredential01";
const args = new Set(process.argv.slice(2));
const startedAt = new Date().toISOString();
const log = (line) => process.stderr.write(`[live-n8n] ${line}\n`);
const checks = [];
let work = null;

function finish(result, exitCode) {
  process.stdout.write(`${JSON.stringify({ ok: exitCode === 0, exitCode, startedAt, finishedAt: new Date().toISOString(), ...result, checks })}\n`);
  process.exitCode = exitCode;
}

function cleanUp() {
  if (!work) return;
  if (args.has("--keep")) {
    // The kept n8n database holds the credential; without the instance's encryption key it cannot be decrypted.
    rmSync(join(work, "user", ".n8n", "config"), { force: true });
    log(`kept ${work} (n8n encryption key removed, so the stored credential cannot be read)`);
  } else {
    rmSync(work, { recursive: true, force: true });
  }
  work = null;
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    args.delete("--keep");
    cleanUp();
    finish({ error: `interrupted (${signal}); a Report Run in flight may still have been recorded`, expected: { runs: null } }, 130);
    process.exit(130);
  });
}

const env = {
  agentId: process.env.AIRPROMPTER_AGENT_ID?.trim(),
  updateKey: process.env.AIRPROMPTER_UPDATE_KEY?.trim(),
  environment: process.env.AIRPROMPTER_ENVIRONMENT?.trim() || "dev",
  apiUrl: process.env.AIRPROMPTER_API_URL?.trim() || "https://api.airprompter.dev",
  deployment: process.env.AIRPROMPTER_DEPLOYMENT?.trim() || "dev",
  rootKey: process.env.AIRPROMPTER_ROOT_KEY?.trim() || "",
  slot: process.env.AIRPROMPTER_SLOT?.trim() || "triage",
  subject: process.env.AIRPROMPTER_SUBJECT?.trim() || "qa-n8n-subject-1",
  n8nVersion: process.env.N8N_VERSION?.trim() || "2.49.8",
};
const base = { agentId: env.agentId ?? null, environment: env.environment, apiUrl: env.apiUrl, deployment: env.deployment, slot: env.slot, subject: env.subject, n8nVersionExpected: env.n8nVersion };

let variables = { ticket: "Refund for order 1042 has not arrived" };
try {
  if (!env.agentId || !env.updateKey) throw new Error("set AIRPROMPTER_AGENT_ID and AIRPROMPTER_UPDATE_KEY (an Update key bound to that agent and AIRPROMPTER_ENVIRONMENT)");
  if (process.env.AIRPROMPTER_VARIABLES?.trim()) {
    variables = JSON.parse(process.env.AIRPROMPTER_VARIABLES);
    if (!variables || typeof variables !== "object" || Array.isArray(variables)) throw new Error("AIRPROMPTER_VARIABLES must be a JSON object");
  }
} catch (error) {
  log(error.message);
  finish({ ...base, error: error.message }, 2);
  process.exit(2);
}

const check = (id, name, ok, detail) => {
  const state = ok === null ? "skipped" : ok ? "pass" : "fail";
  checks.push({ id, name, state, ...(detail === undefined ? {} : { detail }) });
  log(`${state.toUpperCase()} ${id}: ${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};

const freePort = () => new Promise((done, fail) => {
  const server = createServer();
  server.once("error", fail);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});

const countFiles = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length : 0);

try {
  work = mkdtempSync(join(tmpdir(), "airprompter-live-n8n-"));
  const userFolder = join(work, "user");
  const nodesDir = join(userFolder, ".n8n", "nodes");
  mkdirSync(nodesDir, { recursive: true });

  // 1–2. Build, pack, install where n8n keeps community packages.
  if (!args.has("--no-build")) {
    log("building");
    execFileSync("npm", ["run", "build"], { cwd: PACKAGE_DIR, stdio: ["ignore", "ignore", "inherit"] });
  }
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: PACKAGE_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }))[0];
  writeFileSync(join(nodesDir, "package.json"), JSON.stringify({ name: "installed-nodes", private: true }));
  log(`installing ${packed.filename} (${packed.files.length} files) into ${nodesDir}`);
  execFileSync("npm", ["install", join(work, packed.filename), "--omit=dev", "--omit=peer", "--legacy-peer-deps", "--ignore-scripts", "--bin-links=false", "--install-strategy=shallow", "--package-lock=false", "--audit=false", "--fund=false"], { cwd: nodesDir, stdio: ["ignore", "ignore", "inherit"] });
  // n8n's shallow strategy nests the package's own dependencies under it.
  const sdkManifest = [join(nodesDir, "node_modules", "n8n-nodes-airprompter", "node_modules"), join(nodesDir, "node_modules")].map((dir) => join(dir, "@airprompter", "agent-sdk", "package.json")).find((path) => existsSync(path));
  if (!sdkManifest) throw new Error("the install did not bring @airprompter/agent-sdk");
  const sdkVersion = JSON.parse(readFileSync(sdkManifest, "utf8")).version;
  base.sdkVersion = sdkVersion;

  // 3. A fresh n8n: its own user folder, encryption key and task-runner port.
  const n8nEnv = {
    ...process.env,
    N8N_USER_FOLDER: userFolder,
    N8N_ENCRYPTION_KEY: randomBytes(24).toString("hex"),
    N8N_RUNNERS_BROKER_PORT: String(await freePort()),
    DB_TYPE: "sqlite",
    N8N_DIAGNOSTICS_ENABLED: "false",
    N8N_VERSION_NOTIFICATIONS_ENABLED: "false",
    N8N_PERSONALIZATION_ENABLED: "false",
    N8N_LOG_LEVEL: process.env.N8N_LOG_LEVEL || "warn",
  };
  delete n8nEnv.N8N_CUSTOM_EXTENSIONS;
  delete n8nEnv.AIRPROMPTER_UPDATE_KEY;
  const [bin, prefix] = process.env.N8N_BIN ? [process.env.N8N_BIN, []] : ["npx", ["--yes", `n8n@${env.n8nVersion}`]];
  const n8n = (cliArgs, extraEnv = {}) => {
    const result = spawnSync(bin, [...prefix, ...cliArgs], { env: { ...n8nEnv, ...extraEnv }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
  };
  const version = n8n(["--version"]);
  if (version.status !== 0) throw new Error(`n8n did not start: ${version.stderr || version.error?.message}`);
  base.n8nVersion = version.stdout.trim().split("\n").pop();
  log(`n8n ${base.n8nVersion}, SDK ${sdkVersion}, user folder ${userFolder}`);
  check("n8n.version", `n8n is ${env.n8nVersion}, the version this kit is proven on`, args.has("--any-n8n") || base.n8nVersion === env.n8nVersion, base.n8nVersion);

  const credentialsFile = join(work, "credentials.json");
  try {
    writeFileSync(credentialsFile, JSON.stringify([{ id: CREDENTIAL_ID, name: "AirPrompter QA", type: "airPrompterAgentApi", data: { agentId: env.agentId, updateKey: env.updateKey, environment: env.environment, apiBaseUrl: env.apiUrl, hostedEnvironment: env.deployment, rootKey: env.rootKey, rootUrl: "", organizationId: "", storage: "userFolder", bundlePath: "" } }]), { mode: 0o600 });
    const imported = n8n(["import:credentials", `--input=${credentialsFile}`]);
    if (imported.status !== 0) throw new Error(`import:credentials failed: ${imported.stderr.split("\n").slice(-5).join(" ")}`);
  } finally {
    rmSync(credentialsFile, { force: true });
  }

  const workflowsOut = join(work, "workflows");
  mkdirSync(workflowsOut);
  for (const file of readdirSync(WORKFLOWS_DIR).filter((name) => name.endsWith(".json"))) {
    const workflow = JSON.parse(readFileSync(join(WORKFLOWS_DIR, file), "utf8"));
    for (const node of workflow.nodes) {
      if (node.type !== NODE_TYPE || node.parameters.operation !== "getPrompt") continue;
      node.parameters.slot = env.slot;
      node.parameters.variables.value = variables;
      node.parameters.subject = env.subject;
    }
    writeFileSync(join(workflowsOut, file), JSON.stringify(workflow));
  }
  const importedWorkflows = n8n(["import:workflow", "--separate", `--input=${workflowsOut}`]);
  if (importedWorkflows.status !== 0) throw new Error(`import:workflow failed: ${importedWorkflows.stderr.split("\n").slice(-5).join(" ")}`);

  // 4. `n8n execute` exits before a piped stdout drains, so results go to files: a summary (`--output`) and each
  // execution's data (`--snapshot`). `execute-batch` runs in no fixed order and only takes ids with a digit.
  const offlinePreload = join(work, "offline.cjs");
  writeFileSync(offlinePreload, 'globalThis.fetch = async () => { throw new TypeError("fetch failed", { cause: new Error("every request is blocked for the stored-copy check") }); };\n');
  const results = new Map();
  const runBatch = (ids, extraEnv = {}) => {
    const snapshots = join(work, `snapshots-${results.size}`);
    mkdirSync(snapshots);
    const summaryFile = `${snapshots}.json`;
    const started = Date.now();
    const batch = n8n(["execute-batch", `--ids=${ids.join(",")}`, "--concurrency=1", "--retries=0", `--output=${summaryFile}`, `--snapshot=${snapshots}`], extraEnv);
    log(`n8n execute-batch ${ids.join(",")} exited ${batch.status} after ${Date.now() - started} ms`);
    let summary = null;
    try {
      summary = JSON.parse(readFileSync(summaryFile, "utf8"));
    } catch {
      summary = null;
    }
    for (const id of ids) {
      const snapshot = join(snapshots, `${id}-snapshot.json`);
      if (!existsSync(snapshot)) {
        const entry = summary?.executions?.find((execution) => String(execution.workflowId) === id);
        results.set(id, { ok: false, error: entry?.error ?? (batch.stderr || batch.stdout).split("\n").filter(Boolean).slice(-8).join("\n") });
        continue;
      }
      const runData = JSON.parse(readFileSync(snapshot, "utf8")).data?.resultData?.runData ?? {};
      results.set(id, { ok: true, output: (nodeName) => runData[nodeName]?.[0]?.data?.main?.[0]?.map((item) => item.json) ?? [] });
    }
  };
  runBatch(["apQaGetReport001", "apQaUnreported01"]);
  runBatch(["apQaStoredCopy01"], { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${offlinePreload}`.trim() });

  const counted = results.get("apQaGetReport001");
  const served = counted.ok ? counted.output("Get Prompt")[0] : undefined;
  const reported = counted.ok ? counted.output("Report Run")[0]?.airprompter : undefined;
  check("workflow.get_and_report", "Get Prompt → model stub → Report Run ran in n8n", counted.ok, counted.ok ? undefined : counted.error);
  check("get_prompt.network", `Get Prompt served slot ${env.slot} from AirPrompter, verified, with a version and its text`, served?.servedFrom === "network" && served?.slot === env.slot && typeof served?.versionId === "string" && typeof served?.prompt === "string" && served.prompt.length > 0, served ? { slot: served.slot, versionId: served.versionId, arm: served.arm, generation: served.generation, servedFrom: served.servedFrom } : undefined);
  check("get_prompt.run_ref", "Get Prompt returned a run reference", typeof served?.runRef === "string" && served.runRef.length > 0);
  check("report_run.accepted", "Report Run was accepted for that runRef, with the usage detected from the model item", reported?.reported === true && reported.runRef === served?.runRef && reported.inputTokens === 123 && reported.outputTokens === 7, reported ?? (counted.ok ? undefined : counted.error));
  const releases = join(userFolder, ".n8n", "airprompter", env.agentId.replace(/[^A-Za-z0-9._-]/g, "_"), env.environment.replace(/[^A-Za-z0-9._-]/g, "_"), "releases");
  const storedFiles = countFiles(releases);
  check("release.stored", "the signed release is stored in the n8n user folder", storedFiles > 0, `${storedFiles} files`);

  const unreported = results.get("apQaUnreported01");
  const unreportedServed = unreported.ok ? unreported.output("Get Prompt")[0] : undefined;
  check("get_prompt.unreported", "Get Prompt with no Report Run ran and got its own runRef (that it is not counted is for the caller to check in Metrics)", unreported.ok && typeof unreportedServed?.runRef === "string" && unreportedServed.runRef !== served?.runRef, unreported.ok ? undefined : unreported.error);

  const offline = results.get("apQaStoredCopy01");
  const offlineServed = offline.ok ? offline.output("Get Prompt")[0] : undefined;
  check("get_prompt.stored_copy", "with every request failing, Get Prompt served the same version from the stored copy", storedFiles === 0 || !served ? null : offlineServed?.servedFrom === "stored" && offlineServed?.versionId === served?.versionId, storedFiles === 0 || !served ? "skipped: the first run stored nothing" : offline.ok ? { servedFrom: offlineServed?.servedFrom, versionId: offlineServed?.versionId } : offline.error);

  const failed = checks.some((entry) => entry.state === "fail");
  finish({
    ...base,
    getPrompt: served ? { versionId: served.versionId, arm: served.arm ?? null, generation: served.generation, model: served.model, servedFrom: served.servedFrom, leaseExpiresAt: served.leaseExpiresAt } : null,
    reported: reported ? { runRef: reported.runRef, inputTokens: reported.inputTokens, outputTokens: reported.outputTokens, thumbs: "up" } : null,
    // What the agent's Metrics for this environment and slot should gain: exactly one run. If Report Run failed it may
    // still have been recorded (a timeout after the server took it), so runs is null: check Metrics before rerunning.
    expected: { runs: reported?.reported === true ? 1 : null, inputTokens: 123, outputTokens: 7, thumbsUp: 1, versionId: served?.versionId ?? null, arm: served?.arm ?? null },
    notCounted: [unreportedServed?.runRef, offlineServed?.runRef].filter(Boolean),
  }, failed ? 1 : 0);
} catch (error) {
  log(`could not run: ${error.message}`);
  finish({ ...base, error: error.message, expected: { runs: null } }, 1);
} finally {
  cleanUp();
}
