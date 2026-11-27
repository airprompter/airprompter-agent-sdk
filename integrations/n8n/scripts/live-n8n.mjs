#!/usr/bin/env node
/**
 * Runs this package in a real, headless n8n against a live AirPrompter (dev by default) and checks what came back.
 * It is the repeatable proof for AIR-2393 and the driver the n8n QA test calls. It writes nothing to AirPrompter
 * beyond one counted run (Report Run) and the agent's normal check-ins.
 *
 * What it does, in a temporary folder it deletes afterwards (`--keep` leaves it):
 * 1. `npm run build`, then `npm pack`: the same files `npm publish` would ship.
 * 2. Installs that tarball the way n8n installs a community package (production dependencies only, peers from n8n),
 *    so the SDK comes from npm exactly as a customer gets it, and points `N8N_CUSTOM_EXTENSIONS` at it.
 * 3. A fresh `N8N_USER_FOLDER` (SQLite) with two credentials: the live API, and the same key against a closed port.
 * 4. Imports `qa/workflows/*.json` and runs them with `n8n execute-batch` (no retries), the stored-copy run last:
 *    - get-prompt-report-run: Get Prompt → stub model (OpenAI-shaped usage, 123 in / 7 out) → Report Run (detect)
 *    - get-prompt-unreported: Get Prompt only, which must not be counted
 *    - get-prompt-stored-copy: Get Prompt with AirPrompter unreachable, served from the stored copy step 1 wrote
 * 5. Prints one JSON summary on stdout and exits 0 when every check here passes, 1 otherwise. Whether the run shows
 *    in the agent's Metrics is checked by the caller (it needs the owner's console session, which this does not hold).
 *
 * Environment (the Update key is read from the environment only, never from an argument):
 *   AIRPROMPTER_AGENT_ID      required   the agent (agt_…)
 *   AIRPROMPTER_UPDATE_KEY    required   an Update key bound to that agent and AIRPROMPTER_ENVIRONMENT (apa_…)
 *   AIRPROMPTER_ENVIRONMENT   dev        the agent environment the key and the promoted release are bound to
 *   AIRPROMPTER_API_URL       https://api.airprompter.dev
 *   AIRPROMPTER_DEPLOYMENT    dev        the deployment that signs releases (its root is pinned by the SDK)
 *   AIRPROMPTER_SLOT          triage     the slot tag
 *   AIRPROMPTER_VARIABLES     {"ticket":"Refund for order 1042 has not arrived"}   JSON object of the slot's variables
 *   AIRPROMPTER_ROOT_KEY      empty      only for a registry whose root the SDK does not pin (`airprompter dev`): its JWK
 *   N8N_BIN                   n8n on PATH, else `npx --yes n8n@<N8N_VERSION>`
 *   N8N_VERSION               2.49.8     used only when N8N_BIN is unset and n8n is not on PATH
 *
 * @example
 * ```sh
 * AIRPROMPTER_AGENT_ID=agt_… AIRPROMPTER_UPDATE_KEY=apa_… node scripts/live-n8n.mjs
 * # {"ok":true,"reported":{"runRef":"…","inputTokens":123,"outputTokens":7},"getPrompt":{"versionId":"…",…},…}
 * ```
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = join(PACKAGE_DIR, "qa", "workflows");
const args = new Set(process.argv.slice(2));
const log = (line) => process.stderr.write(`[live-n8n] ${line}\n`);

const env = {
  agentId: process.env.AIRPROMPTER_AGENT_ID?.trim(),
  updateKey: process.env.AIRPROMPTER_UPDATE_KEY?.trim(),
  environment: process.env.AIRPROMPTER_ENVIRONMENT?.trim() || "dev",
  apiUrl: process.env.AIRPROMPTER_API_URL?.trim() || "https://api.airprompter.dev",
  deployment: process.env.AIRPROMPTER_DEPLOYMENT?.trim() || "dev",
  slot: process.env.AIRPROMPTER_SLOT?.trim() || "triage",
  variables: process.env.AIRPROMPTER_VARIABLES?.trim() || "",
  rootKey: process.env.AIRPROMPTER_ROOT_KEY?.trim() || "",
};
if (!env.agentId || !env.updateKey) {
  log("set AIRPROMPTER_AGENT_ID and AIRPROMPTER_UPDATE_KEY (an Update key bound to that agent and AIRPROMPTER_ENVIRONMENT)");
  process.exit(2);
}
let variables;
try {
  variables = env.variables ? JSON.parse(env.variables) : null;
  if (variables !== null && (typeof variables !== "object" || Array.isArray(variables))) throw new Error("not an object");
} catch (error) {
  log(`AIRPROMPTER_VARIABLES must be a JSON object: ${error.message}`);
  process.exit(2);
}

function n8nCommand() {
  if (process.env.N8N_BIN) return [process.env.N8N_BIN, []];
  const onPath = spawnSync("n8n", ["--version"], { stdio: "ignore", env: { ...process.env, N8N_USER_FOLDER: tmpdir() } });
  if (onPath.status === 0) return ["n8n", []];
  return ["npx", ["--yes", `n8n@${process.env.N8N_VERSION || "2.49.8"}`]];
}

const work = mkdtempSync(join(tmpdir(), "airprompter-live-n8n-"));
const userFolder = join(work, "user");
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};

try {
  // 1–2. Build, pack, install as n8n installs a community package.
  if (!args.has("--no-build")) {
    log("building");
    execFileSync("npm", ["run", "build"], { cwd: PACKAGE_DIR, stdio: ["ignore", "ignore", "inherit"] });
  }
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: PACKAGE_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }))[0];
  const extension = join(work, "extension");
  mkdirSync(extension);
  writeFileSync(join(extension, "package.json"), JSON.stringify({ name: "airprompter-live-n8n-extension", private: true }));
  log(`installing ${packed.filename} (${packed.files.length} files) with its production dependencies`);
  execFileSync("npm", ["install", join(work, packed.filename), "--omit=dev", "--omit=peer", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], { cwd: extension, stdio: ["ignore", "ignore", "inherit"] });
  const installed = join(extension, "node_modules", "n8n-nodes-airprompter");
  const sdkVersion = JSON.parse(readFileSync(join(extension, "node_modules", "@airprompter", "agent-sdk", "package.json"), "utf8")).version;

  // 3. A fresh n8n user folder and the two credentials.
  mkdirSync(userFolder);
  const n8nEnv = {
    ...process.env,
    N8N_USER_FOLDER: userFolder,
    N8N_CUSTOM_EXTENSIONS: installed,
    N8N_ENCRYPTION_KEY: randomBytes(24).toString("hex"),
    DB_TYPE: "sqlite",
    N8N_DIAGNOSTICS_ENABLED: "false",
    N8N_VERSION_NOTIFICATIONS_ENABLED: "false",
    N8N_PERSONALIZATION_ENABLED: "false",
    N8N_LOG_LEVEL: process.env.N8N_LOG_LEVEL || "warn",
  };
  const [bin, prefix] = n8nCommand();
  const n8n = (cliArgs, options = {}) => {
    const result = spawnSync(bin, [...prefix, ...cliArgs], { env: n8nEnv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000, ...options });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
  };
  const version = n8n(["--version"]);
  if (version.status !== 0) throw new Error(`n8n did not start: ${version.stderr || version.error?.message}`);
  const n8nVersion = version.stdout.trim().split("\n").pop();
  log(`n8n ${n8nVersion}, SDK ${sdkVersion}, user folder ${userFolder}`);

  const credentialData = (apiBaseUrl) => ({
    agentId: env.agentId,
    updateKey: env.updateKey,
    environment: env.environment,
    apiBaseUrl,
    hostedEnvironment: env.deployment,
    rootKey: env.rootKey,
    rootUrl: "",
    organizationId: "",
    storage: "userFolder",
    bundlePath: "",
  });
  const credentials = [
    { id: "apQaCredOnline01", name: "AirPrompter QA (online)", type: "airPrompterAgentApi", data: credentialData(env.apiUrl) },
    // Port 9 (discard) on loopback is closed on any normal machine: AirPrompter is unreachable for this credential.
    { id: "apQaCredOffline1", name: "AirPrompter QA (unreachable)", type: "airPrompterAgentApi", data: credentialData("http://127.0.0.1:9") },
  ];
  const credentialsFile = join(work, "credentials.json");
  writeFileSync(credentialsFile, JSON.stringify(credentials), { mode: 0o600 });
  const importedCredentials = n8n(["import:credentials", `--input=${credentialsFile}`]);
  rmSync(credentialsFile);
  if (importedCredentials.status !== 0) throw new Error(`import:credentials failed: ${importedCredentials.stderr}`);

  // 4. The workflows, with this run's slot and variables.
  const workflowsOut = join(work, "workflows");
  mkdirSync(workflowsOut);
  for (const file of readdirSync(WORKFLOWS_DIR).filter((name) => name.endsWith(".json"))) {
    const workflow = JSON.parse(readFileSync(join(WORKFLOWS_DIR, file), "utf8"));
    for (const node of workflow.nodes) {
      if (node.type !== "CUSTOM.airPrompter" || node.parameters.operation !== "getPrompt") continue;
      node.parameters.slot = env.slot;
      if (variables) node.parameters.variables.value = variables;
    }
    writeFileSync(join(workflowsOut, file), JSON.stringify(workflow));
  }
  const importedWorkflows = n8n(["import:workflow", "--separate", `--input=${workflowsOut}`]);
  if (importedWorkflows.status !== 0) throw new Error(`import:workflow failed: ${importedWorkflows.stderr}`);

  // `n8n execute` exits before a piped stdout drains, so results go to files: a summary (`--output`) and each
  // execution's data (`--snapshot`). `execute-batch` runs in no fixed order and only takes ids with a digit, so the
  // stored-copy run (it needs the release the first run stored) gets a batch of its own. `--retries=0`: a retried
  // Report Run would be counted twice.
  const results = new Map();
  const runBatch = (ids) => {
    const snapshots = join(work, `snapshots-${results.size}`);
    mkdirSync(snapshots);
    const summaryFile = `${snapshots}.json`;
    const started = Date.now();
    const batch = n8n(["execute-batch", `--ids=${ids.join(",")}`, "--concurrency=1", "--retries=0", `--output=${summaryFile}`, `--snapshot=${snapshots}`]);
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
        results.set(id, { ok: false, error: entry?.error ?? (batch.stderr || batch.stdout).split("\n").filter(Boolean).slice(-12).join("\n") });
        continue;
      }
      const data = JSON.parse(readFileSync(snapshot, "utf8"));
      const runData = data.data?.resultData?.runData ?? {};
      results.set(id, { ok: true, output: (nodeName) => runData[nodeName]?.[0]?.data?.main?.[0]?.map((item) => item.json) ?? [] });
    }
  };
  runBatch(["apQaGetReport001", "apQaUnreported01"]);
  runBatch(["apQaStoredCopy01"]);
  const execute = (id) => results.get(id);

  // get-prompt-report-run
  const counted = execute("apQaGetReport001");
  check("Get Prompt → model → Report Run executes in n8n", counted.ok, counted.ok ? undefined : counted.error);
  const served = counted.ok ? counted.output("Get Prompt")[0] : undefined;
  const reported = counted.ok ? counted.output("Report Run")[0]?.airprompter : undefined;
  check("Get Prompt serves the approved version from a verified, signed manifest, fetched now", served?.servedFrom === "network" && served?.slot === env.slot && typeof served?.versionId === "string" && typeof served?.prompt === "string" && served.prompt.length > 0, served && { slot: served.slot, versionId: served.versionId, arm: served.arm, generation: served.generation, servedFrom: served.servedFrom });
  check("Get Prompt returns a run reference", typeof served?.runRef === "string" && served.runRef.length > 0);
  check("Report Run is accepted for that runRef, with the usage detected from the model item", reported?.reported === true && reported.runRef === served?.runRef && reported.inputTokens === 123 && reported.outputTokens === 7, reported);
  const releases = join(userFolder, ".n8n", "airprompter", env.agentId.replace(/[^A-Za-z0-9._-]/g, "_"), env.environment.replace(/[^A-Za-z0-9._-]/g, "_"), "releases");
  const storedFiles = existsSync(releases) ? readdirSync(releases, { recursive: true }).length : 0;
  check("the signed release is stored in the n8n user folder", storedFiles > 0, `${releases} (${storedFiles} entries)`);

  // get-prompt-unreported
  const unreported = execute("apQaUnreported01");
  const unreportedServed = unreported.ok ? unreported.output("Get Prompt")[0] : undefined;
  check("a Get Prompt with no Report Run executes (and is not reported)", unreported.ok && typeof unreportedServed?.runRef === "string" && unreportedServed.runRef !== served?.runRef, unreported.ok ? undefined : unreported.error);

  // get-prompt-stored-copy
  const offline = execute("apQaStoredCopy01");
  const offlineServed = offline.ok ? offline.output("Get Prompt")[0] : undefined;
  check("with AirPrompter unreachable, Get Prompt serves the same version from the stored copy", offlineServed?.servedFrom === "stored" && offlineServed?.versionId === served?.versionId, offline.ok ? { servedFrom: offlineServed?.servedFrom, versionId: offlineServed?.versionId } : offline.error);

  const ok = checks.every((entry) => entry.ok);
  process.stdout.write(
    `${JSON.stringify({
      ok,
      n8nVersion,
      sdkVersion,
      agentId: env.agentId,
      environment: env.environment,
      apiUrl: env.apiUrl,
      slot: env.slot,
      getPrompt: served ? { versionId: served.versionId, arm: served.arm ?? null, generation: served.generation, model: served.model, servedFrom: served.servedFrom, leaseExpiresAt: served.leaseExpiresAt } : null,
      reported: reported ? { runRef: reported.runRef, inputTokens: reported.inputTokens, outputTokens: reported.outputTokens } : null,
      expectedCountedRuns: reported?.reported === true ? 1 : 0,
      checks,
    })}\n`,
  );
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  log(`could not run: ${error.message}`);
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, checks })}\n`);
  process.exitCode = 1;
} finally {
  if (args.has("--keep")) log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
