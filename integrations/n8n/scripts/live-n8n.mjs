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
 * Offline (a CI image that must not reach the npm registry at test time): steps 1–2 once, at image build time,
 * into a folder of their own, then every run copies that folder instead of building and installing:
 *   node scripts/live-n8n.mjs --prepare-nodes-dir /opt/airprompter/n8n-nodes           # build time: npm, network
 *   N8N_BIN=/opt/n8n/n8n node scripts/live-n8n.mjs --nodes-dir /opt/airprompter/n8n-nodes   # test time: no npm
 * Prepare records `airprompter-kit.json`: package and SDK versions, the tarball's sha256, a sha256 over the installed
 * package, and the commit (required: from git, or AIRPROMPTER_KIT_COMMIT for a copy without .git; a modified tree is
 * refused). A run with `--nodes-dir` needs N8N_BIN (npx would reach the registry), runs no npm at all, reaches only
 * AirPrompter, and checks the copy (`nodes.prepared`): same content hash and versions, and the commit the caller pins
 * (AIRPROMPTER_KIT_COMMIT) or else this checkout's. `qa/README.md` › Offline has the image recipe.
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
 *   N8N_BIN                   empty      an n8n to use instead of `npx --yes n8n@$N8N_VERSION`; required with --nodes-dir
 *   AIRPROMPTER_KIT_NODES_DIR empty      same as --nodes-dir
 *   AIRPROMPTER_KIT_COMMIT    empty      prepare: the commit of a copy without .git; a run: the commit to expect
 *   AIRPROMPTER_EXPECTED_PROMPT_SHA256  empty   the sha256 the rendered prompt must have: adds the get_prompt.rendered check
 * Flags (`--flag value` or `--flag=value`; anything else exits 2): --keep (leave the folder, without the n8n
 *   encryption key, for debugging), --no-build, --any-n8n, --prepare-nodes-dir <folder>, --nodes-dir <folder>.
 *
 * @example
 * ```sh
 * AIRPROMPTER_AGENT_ID=agent_… AIRPROMPTER_UPDATE_KEY=apa_… node scripts/live-n8n.mjs
 * # {"ok":true,"exitCode":0,"getPrompt":{"promptSha256":"…","versionId":"…","servedFrom":"network",…},"expected":{"runs":1,…},…}
 * ```
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = join(PACKAGE_DIR, "qa", "workflows");
const NODE_TYPE = "n8n-nodes-airprompter.airPrompter";
const CREDENTIAL_ID = "apQaCredential01";
const startedAt = new Date().toISOString();
const log = (line) => process.stderr.write(`[live-n8n] ${line}\n`);
const checks = [];
let work = null;
const KIT_MANIFEST = "airprompter-kit.json";

/**
 * Strict flags: `--flag value` or `--flag=value`. An unknown flag, a flag without its value, or a stray argument is
 * refused (exit 2), so a typo never falls back quietly to the default, npm-using path.
 */
const BOOLEAN_FLAGS = new Set(["--keep", "--no-build", "--any-n8n"]);
const VALUE_FLAGS = new Set(["--nodes-dir", "--prepare-nodes-dir"]);
function parseArgs(list) {
  const flags = new Set();
  const values = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const [name, inline] = list[i].startsWith("--") && list[i].includes("=") ? [list[i].slice(0, list[i].indexOf("=")), list[i].slice(list[i].indexOf("=") + 1)] : [list[i], undefined];
    if (BOOLEAN_FLAGS.has(name) && inline === undefined) flags.add(name);
    else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? list[i + 1];
      if (inline === undefined) i += 1;
      if (!value || value.startsWith("--")) throw new Error(`${name} needs a folder`);
      values.set(name, value);
    } else throw new Error(`unknown argument ${JSON.stringify(list[i])} (flags: ${[...BOOLEAN_FLAGS, ...VALUE_FLAGS].join(", ")})`);
  }
  if (values.has("--nodes-dir") && values.has("--prepare-nodes-dir")) throw new Error("use --prepare-nodes-dir (image build) or --nodes-dir (a run), not both");
  return { flags, values };
}
let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  log(error.message);
  process.stdout.write(`${JSON.stringify({ ok: false, exitCode: 2, startedAt, error: error.message, checks })}\n`);
  process.exit(2);
}
const args = parsed.flags;

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

/** What `npm run build` and `npm pack` read: anything here that is not committed changes the package. */
// npm packs root README*, LICENSE* and LICENCE* files whatever `files` says, so any of those names counts too.
const BUILD_INPUTS = ["src", "nodes", "credentials", "scripts/copy-icons.mjs", "package.json", "package-lock.json", "tsconfig.json", ":(glob)README*", ":(glob)LICENSE*", ":(glob)LICENCE*"];
const git = (gitArgs) => execFileSync("git", gitArgs, { cwd: PACKAGE_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
/**
 * This checkout's own commit, or null: only when this folder is tracked as `integrations/n8n` of its repository, so a
 * copy inside some other checkout never borrows that checkout's HEAD. `dirty` when files here differ from it.
 */
function checkoutCommit() {
  try {
    if (resolve(git(["rev-parse", "--show-toplevel"]), "integrations", "n8n") !== PACKAGE_DIR) return null;
    git(["ls-files", "--error-unmatch", "package.json"]);
    // Dirty: a modified tracked file anywhere here, or an untracked file among the build's inputs (an untracked .ts
    // under src/ would be compiled into the package). Untracked files elsewhere, such as a run's own output, are not.
    const modified = git(["status", "--porcelain", "--untracked-files=no", "--", "."]);
    const untrackedInputs = git(["status", "--porcelain", "--untracked-files=all", "--", ...BUILD_INPUTS]);
    return { commit: git(["rev-parse", "HEAD"]), dirty: modified !== "" || untrackedInputs !== "" };
  } catch {
    return null;
  }
}

/** A sha256 over every file under the folder's node_modules (paths and bytes, sorted): the package and everything it brought. */
function contentSha256(dir) {
  const hash = createHash("sha256");
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => relative(dir, join(entry.parentPath ?? entry.path, entry.name))).sort();
  for (const file of files) hash.update(`${file}\0`).update(readFileSync(join(dir, file))).update("\0");
  return hash.digest("hex");
}

function refuseSymlinks(dir) {
  const link = readdirSync(dir, { recursive: true, withFileTypes: true }).find((entry) => entry.isSymbolicLink());
  if (link) throw new Error(`${dir} contains a symbolic link (${join(link.parentPath ?? link.path, link.name)}); a prepared folder has none`);
}

/**
 * Steps 1–2: build, pack, and install the tarball into `nodesDir` the way n8n installs a community package. Returns
 * what was installed. Used per run by default, and once by --prepare-nodes-dir.
 */
function packAndInstall(nodesDir, scratch) {
  if (!args.has("--no-build")) {
    log("building");
    execFileSync("npm", ["run", "build"], { cwd: PACKAGE_DIR, stdio: ["ignore", "ignore", "inherit"] });
  }
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", scratch], { cwd: PACKAGE_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }))[0];
  const tarball = join(scratch, packed.filename);
  writeFileSync(join(nodesDir, "package.json"), JSON.stringify({ name: "installed-nodes", private: true }));
  log(`installing ${packed.filename} (${packed.files.length} files) into ${nodesDir}`);
  execFileSync("npm", ["install", tarball, "--omit=dev", "--omit=peer", "--legacy-peer-deps", "--ignore-scripts", "--bin-links=false", "--install-strategy=shallow", "--package-lock=false", "--audit=false", "--fund=false"], { cwd: nodesDir, stdio: ["ignore", "ignore", "inherit"] });
  return { package: packed.name, packageVersion: packed.version, tarballSha256: createHash("sha256").update(readFileSync(tarball)).digest("hex") };
}

/** What is installed in a community-nodes folder: the package, and the SDK under it (n8n's shallow strategy nests it). */
function installedIn(nodesDir) {
  const pkg = join(nodesDir, "node_modules", "n8n-nodes-airprompter", "package.json");
  if (!existsSync(pkg)) throw new Error(`${nodesDir} has no node_modules/n8n-nodes-airprompter`);
  const sdkManifest = [join(nodesDir, "node_modules", "n8n-nodes-airprompter", "node_modules"), join(nodesDir, "node_modules")].map((dir) => join(dir, "@airprompter", "agent-sdk", "package.json")).find((path) => existsSync(path));
  if (!sdkManifest) throw new Error(`${nodesDir} has no @airprompter/agent-sdk under the package`);
  return { packageVersion: JSON.parse(readFileSync(pkg, "utf8")).version, sdkVersion: JSON.parse(readFileSync(sdkManifest, "utf8")).version, contentSha256: contentSha256(join(nodesDir, "node_modules")) };
}

const bad = (message) => Object.assign(new Error(message), { exitCode: 2 });
/** A commit is a full 40-character sha: a branch name, a tag or a short prefix would match too much. */
const FULL_SHA = /^[0-9a-f]{40}$/;

// --prepare-nodes-dir: steps 1–2 only, into a folder of its own, for an image built ahead of offline runs.
if (parsed.values.has("--prepare-nodes-dir")) {
  const target = resolve(parsed.values.get("--prepare-nodes-dir"));
  let scratch = null;
  let staging = null;
  let outcome;
  try {
    if (args.has("--no-build")) throw bad("--prepare-nodes-dir always builds, so the folder matches the commit it names; drop --no-build");
    if (existsSync(target) && (!statSync(target).isDirectory() || readdirSync(target).length > 0)) throw bad(`${target} is not an empty folder`);
    // The commit the folder is made from, required: from git when this is the repository's own checkout (and the
    // tree is clean), else AIRPROMPTER_KIT_COMMIT (a copy without .git, such as a Docker build). Both: they must agree.
    const fromGit = checkoutCommit();
    const declared = process.env.AIRPROMPTER_KIT_COMMIT?.trim() || null;
    if (declared && !FULL_SHA.test(declared)) throw bad(`AIRPROMPTER_KIT_COMMIT must be a full 40-character commit sha, not ${JSON.stringify(declared)}`);
    if (fromGit?.dirty) throw bad(`integrations/n8n has changes not committed in ${fromGit.commit}; commit them, or prepare from a clean checkout`);
    if (fromGit && declared && fromGit.commit !== declared) throw bad(`AIRPROMPTER_KIT_COMMIT ${declared} is not this checkout's commit ${fromGit.commit}`);
    const commit = fromGit?.commit ?? declared;
    if (!commit) throw bad("no commit to record: run from a git checkout of the repository, or set AIRPROMPTER_KIT_COMMIT to the commit this copy is");
    // Install into a sibling folder and rename at the end, so a failure leaves the target as it was.
    mkdirSync(dirname(target), { recursive: true });
    staging = mkdtempSync(`${target}.partial-`);
    scratch = mkdtempSync(join(tmpdir(), "airprompter-live-n8n-pack-"));
    const kit = { ...packAndInstall(staging, scratch), ...installedIn(staging), commit, preparedAt: new Date().toISOString() };
    refuseSymlinks(staging);
    writeFileSync(join(staging, KIT_MANIFEST), `${JSON.stringify(kit, null, 2)}\n`);
    if (existsSync(target)) rmSync(target, { recursive: true });
    renameSync(staging, target);
    staging = null;
    log(`prepared ${target}: ${kit.package} ${kit.packageVersion}, SDK ${kit.sdkVersion}, commit ${kit.commit}`);
    outcome = { ok: true, exitCode: 0, nodesDir: target, kit };
  } catch (error) {
    log(error.message);
    outcome = { ok: false, exitCode: error.exitCode ?? 1, nodesDir: target, error: error.message };
  }
  // Before exiting: process.exit would skip a finally. (Prepare is synchronous: an interrupt ends it with exit 1.)
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (staging) rmSync(staging, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  process.exit(outcome.exitCode);
}
const preinstalled = parsed.values.get("--nodes-dir") ?? (process.env.AIRPROMPTER_KIT_NODES_DIR?.trim() || undefined);
// Set but unusable must not fall back quietly to the npm path: the old name, or a blank value.
const nodesDirEnvProblem = process.env.N8N_NODES_DIR !== undefined
  ? "N8N_NODES_DIR is not read; the variable is AIRPROMPTER_KIT_NODES_DIR"
  : process.env.AIRPROMPTER_KIT_NODES_DIR !== undefined && !process.env.AIRPROMPTER_KIT_NODES_DIR.trim() && !parsed.values.has("--nodes-dir")
    ? "AIRPROMPTER_KIT_NODES_DIR is set but empty"
    : null;
const n8nBin = process.env.N8N_BIN?.trim() || "";

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
  if (nodesDirEnvProblem) throw new Error(nodesDirEnvProblem);
  const expectedPrompt = process.env.AIRPROMPTER_EXPECTED_PROMPT_SHA256?.trim();
  if (expectedPrompt && !/^[0-9a-f]{64}$/.test(expectedPrompt)) throw new Error("AIRPROMPTER_EXPECTED_PROMPT_SHA256 must be a sha256 in lowercase hex (64 characters)");
  if (preinstalled) {
    // Offline means no npm at all: npx would fetch n8n from the registry.
    if (!n8nBin) throw new Error("--nodes-dir runs offline and needs N8N_BIN (a pre-installed n8n), not npx");
    const pinned = process.env.AIRPROMPTER_KIT_COMMIT?.trim();
    if (pinned && !FULL_SHA.test(pinned)) throw new Error(`AIRPROMPTER_KIT_COMMIT must be a full 40-character commit sha, not ${JSON.stringify(pinned)}`);
    const source = existsSync(preinstalled) ? realpathSync(preinstalled) : resolve(preinstalled);
    if (!existsSync(join(source, KIT_MANIFEST))) throw new Error(`${source} has no ${KIT_MANIFEST}: make it with --prepare-nodes-dir`);
    installedIn(source);
    refuseSymlinks(source);
  }
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

/** The sha256 (lowercase hex) of the exact prompt string the node returned, as UTF-8 bytes; the text never leaves. */
const promptSha256 = (prompt) => (typeof prompt === "string" ? createHash("sha256").update(prompt, "utf8").digest("hex") : null);
const countFiles = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length : 0);

try {
  work = mkdtempSync(join(tmpdir(), "airprompter-live-n8n-"));
  const userFolder = join(work, "user");
  const nodesDir = join(userFolder, ".n8n", "nodes");
  mkdirSync(nodesDir, { recursive: true });

  // 1–2. Build, pack, install where n8n keeps community packages; or copy a folder prepared ahead (no npm, offline).
  const checkout = checkoutCommit();
  if (preinstalled) {
    const source = realpathSync(preinstalled); // a pointer such as /opt/…/current is followed once, here
    const kit = JSON.parse(readFileSync(join(source, KIT_MANIFEST), "utf8"));
    cpSync(source, nodesDir, { recursive: true });
    const copied = installedIn(nodesDir);
    const checkoutVersion = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")).version;
    // The commits to compare with, exactly: the one the caller pins (AIRPROMPTER_KIT_COMMIT) and this checkout's own,
    // each when known. With neither known the check fails: it never passes without having compared a commit.
    const expected = [process.env.AIRPROMPTER_KIT_COMMIT?.trim(), checkout?.commit].filter(Boolean);
    const commitOk = FULL_SHA.test(kit.commit ?? "") && expected.length > 0 && expected.every((commit) => commit === kit.commit);
    base.nodes = { mode: "preinstalled", from: source, kit, checkoutCommit: checkout?.commit ?? null };
    log(`using the community-nodes folder prepared in ${source} (commit ${kit.commit}); no npm`);
    const contentOk = copied.contentSha256 === kit.contentSha256 && copied.packageVersion === kit.packageVersion && copied.sdkVersion === kit.sdkVersion && kit.packageVersion === checkoutVersion;
    check("nodes.prepared", "the prepared folder is intact and is the package this checkout runs: same content hash, versions and commit", contentOk && commitOk, { kitCommit: kit.commit, expectedCommits: expected.length ? expected : "none known: set AIRPROMPTER_KIT_COMMIT to the full sha you pin", contentHashMatches: copied.contentSha256 === kit.contentSha256, packageVersion: copied.packageVersion, checkoutVersion });
    // A folder that is not what was pinned must not record a Report Run: stop before n8n.
    if (!(contentOk && commitOk)) throw new Error("the prepared folder does not match (check nodes.prepared); n8n was not started, nothing was sent to AirPrompter");
  } else {
    base.nodes = { mode: "packed", kit: { ...packAndInstall(nodesDir, work), commit: checkout?.commit ?? null, dirty: checkout?.dirty ?? null } };
  }
  let sdkVersion;
  try {
    ({ sdkVersion } = installedIn(nodesDir));
  } catch (error) {
    throw new Error(`the install in the run's user folder is incomplete: ${error.message}`);
  }
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
    N8N_TEMPLATES_ENABLED: "false",
    // Offline: should anything in n8n reach for npm, it gets the cache or fails, never the registry.
    ...(preinstalled ? { npm_config_offline: "true" } : {}),
  };
  delete n8nEnv.N8N_CUSTOM_EXTENSIONS;
  delete n8nEnv.AIRPROMPTER_UPDATE_KEY;
  delete n8nEnv.AIRPROMPTER_KIT_NODES_DIR;
  const [bin, prefix] = n8nBin ? [n8nBin, []] : ["npx", ["--yes", `n8n@${env.n8nVersion}`]];
  const n8n = (cliArgs, extraEnv = {}) => {
    const result = spawnSync(bin, [...prefix, ...cliArgs], { env: { ...n8nEnv, ...extraEnv }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
  };
  const version = n8n(["--version"]);
  if (version.status !== 0) throw new Error(`n8n did not start: ${version.stderr || version.error?.message}`);
  // n8n answers --version before it checks its Node floor (>=24), so probe the check itself.
  const probe = n8n(["--help"]);
  if (/Your Node\.js version/.test(`${probe.stdout}${probe.stderr}`)) throw new Error(`N8N_BIN runs n8n on a Node older than it accepts: ${`${probe.stderr}${probe.stdout}`.trim().split("\n").filter(Boolean).slice(0, 2).join(" ")}`);
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
  runBatch(["apQaStoredCopy01"], { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require "${offlinePreload}"`.trim() });

  const counted = results.get("apQaGetReport001");
  const served = counted.ok ? counted.output("Get Prompt")[0] : undefined;
  const reported = counted.ok ? counted.output("Report Run")[0]?.airprompter : undefined;
  check("workflow.get_and_report", "Get Prompt → model stub → Report Run ran in n8n", counted.ok, counted.ok ? undefined : counted.error);
  check("get_prompt.network", `Get Prompt served slot ${env.slot} from AirPrompter, verified, with a version and its text`, served?.servedFrom === "network" && served?.slot === env.slot && typeof served?.versionId === "string" && typeof served?.prompt === "string" && served.prompt.length > 0, served ? { slot: served.slot, versionId: served.versionId, arm: served.arm, generation: served.generation, servedFrom: served.servedFrom } : undefined);
  check("get_prompt.run_ref", "Get Prompt returned a run reference", typeof served?.runRef === "string" && served.runRef.length > 0);
  const expectedPromptSha256 = process.env.AIRPROMPTER_EXPECTED_PROMPT_SHA256?.trim();
  if (expectedPromptSha256) check("get_prompt.rendered", "Get Prompt rendered exactly the expected text (its sha256 equals AIRPROMPTER_EXPECTED_PROMPT_SHA256)", promptSha256(served?.prompt) === expectedPromptSha256, { promptSha256: promptSha256(served?.prompt), expected: expectedPromptSha256 });
  check("report_run.accepted", "Report Run was accepted for that runRef, with the usage detected from the model item", reported?.reported === true && reported.runRef === served?.runRef && reported.inputTokens === 123 && reported.outputTokens === 7, reported ?? (counted.ok ? undefined : counted.error));
  const releases = join(userFolder, ".n8n", "airprompter", env.agentId.replace(/[^A-Za-z0-9._-]/g, "_"), env.environment.replace(/[^A-Za-z0-9._-]/g, "_"), "releases");
  const storedFiles = countFiles(releases);
  check("release.stored", "the signed release is stored in the n8n user folder", storedFiles > 0, `${storedFiles} files`);

  const unreported = results.get("apQaUnreported01");
  const unreportedServed = unreported.ok ? unreported.output("Get Prompt")[0] : undefined;
  check("get_prompt.unreported", "Get Prompt with no Report Run ran and got its own runRef (that it is not counted is for the caller to check in Metrics)", unreported.ok && typeof unreportedServed?.runRef === "string" && unreportedServed.runRef !== served?.runRef, unreported.ok ? undefined : unreported.error);

  const offline = results.get("apQaStoredCopy01");
  const offlineServed = offline.ok ? offline.output("Get Prompt")[0] : undefined;
  check("get_prompt.stored_copy", "with every request failing, Get Prompt served the same version and text from the stored copy", storedFiles === 0 || !served ? null : offlineServed?.servedFrom === "stored" && offlineServed?.versionId === served?.versionId && promptSha256(offlineServed?.prompt) === promptSha256(served?.prompt), storedFiles === 0 || !served ? "skipped: the first run stored nothing" : offline.ok ? { servedFrom: offlineServed?.servedFrom, versionId: offlineServed?.versionId, sameText: promptSha256(offlineServed?.prompt) === promptSha256(served?.prompt) } : offline.error);

  const failed = checks.some((entry) => entry.state === "fail");
  finish({
    ...base,
    // promptSha256 / promptBytes: of the rendered prompt the node returned in the counted (network) run, so a test
    // can check the text without it leaving the run (qa/README.md › What to assert says how to compute the expected one).
    getPrompt: served ? { promptSha256: promptSha256(served.prompt), promptBytes: typeof served.prompt === "string" ? Buffer.byteLength(served.prompt, "utf8") : null, versionId: served.versionId, arm: served.arm ?? null, generation: served.generation, model: served.model, servedFrom: served.servedFrom, leaseExpiresAt: served.leaseExpiresAt } : null,
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
