#!/usr/bin/env node
/**
 * The `examples` CI job, for one example or all of them: each example runs unchanged against a local registry and a
 * fake provider, with no provider key and no AirPrompter account.
 *
 * 1. Builds the CLI from this commit and serves a copy of `examples/prompts/` with `airprompter dev`.
 * 2. Starts `fake-provider.mjs`, which plays one recorded tool loop in the OpenAI wire format.
 * 3. Packs the SDK (`npm pack`, what `npm publish` would ship) and installs it in a copy of the example in place of
 *    the pinned version, because a pinned version is not on npm until it is released. The pin must equal the packed
 *    version (`version-lockstep` keeps it there).
 * 4. Runs the example's `typecheck` script, if it has one, then its `start` script, with only the registry's and the
 *    fake's addresses in the environment. No provider key from the caller's shell reaches it.
 * 5. Checks that the provider received the approved prompt text and the release's model on every call, that the
 *    agent printed the recorded answer, and that the spool holds one window row with `count: 1` for the whole request.
 * 6. Edits the prompt while the registry runs, as the README's last step does, and runs the example again on the same
 *    state folder: every call must carry the edited text.
 *
 * `--latest` installs the newest release of each framework package in place of its pin. `--published` installs the
 * example exactly as a developer copying it would, from npm, and serves the prompts with the newest released CLI; an
 * example whose SDK pin is not on npm yet is skipped. Both run weekly in `wrap-latest.yml`.
 *
 * @example
 * ```sh
 * $ (cd sdk-typescript && npm ci) && (cd cli && npm ci)
 * $ node examples/ci/run.mjs langchain-typescript      # one example
 * $ node examples/ci/run.mjs                           # every example
 * $ node examples/ci/run.mjs --latest                  # against each framework's newest release
 * $ node examples/ci/run.mjs --published               # the released SDK and CLI, as a developer gets them
 * ```
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { recording, startFakeProvider, TOOL } from "./fake-provider.mjs";

const repo = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const RUN_TIMEOUT_MS = 120_000;

/**
 * Every example the job runs, and the slot it serves. A Python example adds a `python` runner beside `node`
 * (a venv, `pip install` of the built wheel in place of the pin, `python agent.py`).
 */
const EXAMPLES = {
  "langchain-typescript": { runner: "node", slot: "support.reply", prompt: "support/reply.md" },
};
/** Folders in examples/ that are not framework examples, so the job never runs them. */
const NOT_EXAMPLES = new Set(["ci", "prompts", "python-worker", "spool-writer", "conformance-adapter"]);

const args = process.argv.slice(2);
const latest = args.includes("--latest");
const published = args.includes("--published");
const chosen = args.filter((arg) => !arg.startsWith("--"));
for (const name of chosen) if (!EXAMPLES[name]) usage(`unknown example ${name}; the examples are ${Object.keys(EXAMPLES).join(", ")}`);
const names = chosen.length ? chosen : Object.keys(EXAMPLES);

function usage(message) {
  console.error(`run.mjs: ${message}`);
  process.exit(2);
}

// Only npm needs a shell on Windows (it is a .cmd). A shell joins arguments unquoted, so nothing else goes through one.
const shellFor = (command) => process.platform === "win32" && command === npm;
// Output goes straight to the console, so a failed build or typecheck shows tsc's own errors. `read` is for the one
// command whose output is parsed (`npm pack --json`).
const sh = (command, argv, cwd, env) => execFileSync(command, argv, { cwd, env, stdio: ["ignore", "inherit", "inherit"], shell: shellFor(command) });
const read = (command, argv, cwd) => execFileSync(command, argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], shell: shellFor(command) });

/** A folder that looks like an example but is not in EXAMPLES would never run, so it fails the job instead. */
function unlisted() {
  return readdirSync(join(repo, "examples"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NOT_EXAMPLES.has(entry.name) && !EXAMPLES[entry.name])
    .filter((entry) => ["package.json", "pyproject.toml"].some((file) => existsSync(join(repo, "examples", entry.name, file))))
    .map((entry) => entry.name);
}

/** What `airprompter dev` serves for a prompt file: the text without its front matter, and the front matter's model. */
function approved(relativePath) {
  const raw = readFileSync(join(repo, "examples", "prompts", relativePath), "utf8").replace(/\r\n/g, "\n");
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  const model = front ? /^model:\s*(.+)$/m.exec(front[1])?.[1].trim() : undefined;
  return { text: (front ? raw.slice(front[0].length) : raw).trim(), model: model ?? "claude-sonnet-5" };
}

/** `airprompter dev` as its own process; resolves with the facts it prints on its first line. */
async function startRegistry(command, dir) {
  const child = spawn(command[0], [...command.slice(1), "dev", dir, "--port", "0", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
  const state = { exited: null, stderr: "" };
  child.stderr.setEncoding("utf8").on("data", (chunk) => (state.stderr += chunk));
  child.once("exit", (code, signal) => (state.exited = code ?? signal));
  let out = "";
  const facts = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`airprompter dev did not start in 30 s: ${state.stderr}`)), 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      out += chunk;
      if (!out.includes("\n")) return;
      clearTimeout(timer);
      try {
        done(JSON.parse(out.slice(0, out.indexOf("\n"))));
      } catch {
        fail(new Error(`airprompter dev printed something other than its facts: ${out}`));
      }
    });
    child.once("exit", (code) => fail(new Error(`airprompter dev exited ${code}: ${state.stderr}`)));
  });
  return { facts, state, stop: () => child.kill("SIGTERM") };
}

/** The newest released CLI for this machine, from GitHub, for `--published`. */
async function releasedCli(work) {
  const asset = { "darwin-arm64": "airprompter-darwin-arm64", "linux-x64": "airprompter-linux-x64", "linux-arm64": "airprompter-linux-arm64", "win32-x64": "airprompter-windows-x64.exe" }[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`no released CLI for ${process.platform}-${process.arch}`);
  const headers = { accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const listing = await fetch("https://api.github.com/repos/airprompter/airprompter-agent-sdk/releases?per_page=100", { headers });
  if (!listing.ok) throw new Error(`the GitHub releases listing answered ${listing.status}`);
  const release = (await listing.json()).find((r) => r.tag_name?.startsWith("cli/v"));
  const url = release?.assets.find((a) => a.name === asset)?.browser_download_url;
  if (!url) throw new Error(`no ${asset} on the newest cli/v release`);
  const download = await fetch(url);
  if (!download.ok) throw new Error(`${url} answered ${download.status}`);
  const path = join(work, asset);
  writeFileSync(path, Buffer.from(await download.arrayBuffer()));
  chmodSync(path, 0o755);
  console.log(`Serving the prompts with the released CLI ${release.tag_name}`);
  return [path];
}

/** A copy filter: nothing a local run left behind (installs, a lockfile, the dev registry's keys). */
const LOCAL = new Set(["node_modules", "package-lock.json", ".airprompter-dev", ".venv"]);
const outside = (root) => (src) => !relative(root, src).split(sep).some((part) => LOCAL.has(part));

/**
 * Every window row in the spool's closed segments. They are still there after `ap.stop()` because `airprompter dev`
 * issues no upload grant, so the agent's last upload pass leaves them; a registry that did would empty the spool.
 */
function windowRows(spoolDir) {
  if (!existsSync(spoolDir)) return [];
  const rows = [];
  for (const file of readdirSync(spoolDir).filter((name) => /^seg-.*\.ndjson$/.test(name))) {
    for (const line of readFileSync(join(spoolDir, file), "utf8").split("\n").filter(Boolean)) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        rows.push({ type: "unreadable", file });
      }
    }
  }
  return rows.filter((row) => row.type === "window" || row.type === "unreadable");
}

const RUNNERS = {
  node: {
    /**
     * A copy of the example with the packed SDK in place of its pin (none with `--published`); `--latest` moves every
     * other dependency to its newest release. Answers false when `--published` finds the pin not on npm yet.
     */
    install(dir, tarballs, version) {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      for (const [dep, range] of Object.entries(manifest.dependencies)) {
        if (!dep.startsWith("@airprompter/")) continue;
        if (published) {
          const found = spawnSync(npm, ["view", `${dep}@${range}`, "version"], { encoding: "utf8", shell: shellFor(npm) });
          if (found.status !== 0 || !found.stdout.trim()) {
            // A skip is green, so on a CI run it is a warning too: a week of skips tested nothing.
            const message = `${dep}@${range} is not on npm yet (it is published with its release), so this example was not run as published`;
            console.log(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `  skipped: ${message}`);
            return false;
          }
          continue;
        }
        if (range !== version) throw new Error(`package.json pins ${dep}@${range}, but this commit's SDK is ${version}: run (cd sdk-typescript && npm run version:lockstep -- --set ${version})`);
        if (!tarballs[dep]) throw new Error(`no packed tarball for ${dep}`);
        manifest.dependencies[dep] = `file:${tarballs[dep]}`;
      }
      writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      sh(npm, ["install", "--no-audit", "--no-fund", "--ignore-scripts"], dir);
      if (latest) {
        const frameworks = Object.keys(manifest.dependencies).filter((dep) => !dep.startsWith("@airprompter/"));
        sh(npm, ["install", "--no-save", "--no-audit", "--no-fund", "--ignore-scripts", ...frameworks.map((dep) => `${dep}@latest`)], dir);
      }
      const installed = Object.keys(manifest.dependencies).map((dep) => `${dep}@${JSON.parse(readFileSync(join(dir, "node_modules", dep, "package.json"), "utf8")).version}`);
      console.log(`  installed: ${installed.join(", ")}`);
      if (manifest.scripts?.typecheck) sh(npm, ["run", "--silent", "typecheck"], dir);
      return true;
    },
    run: (dir, env) => run(npm, ["run", "--silent", "start"], dir, env),
  },
};

/**
 * The example's own process group (npm, tsx, node), killed whole if it outlives the timeout or this script is
 * interrupted. It resolves on `close`, once its output is all read, never on `exit`, which can come first.
 */
let live = null;
const killGroup = (child) => {
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // already gone
  }
};
process.once("SIGINT", () => {
  if (live) killGroup(live);
  cleanUp();
  process.exit(130);
});
function run(command, argv, cwd, env) {
  return new Promise((done) => {
    const child = spawn(command, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: shellFor(command), detached: process.platform !== "win32" });
    live = child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, RUN_TIMEOUT_MS);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      live = null;
      done({ code, signal, timedOut, stdout, stderr });
    });
  });
}

/** The newest generation the registry has signed: the one it started on, or the last it logged. */
const newestGeneration = (registry) => Math.max(registry.facts.generation, ...[...registry.state.stderr.matchAll(/"event":"generation","generation":(\d+)/g)].map((m) => Number(m[1])));

/** Resolves once the registry has signed a generation past `after`, or fails after 60 s (its file watcher can be slow on a loaded machine). */
async function generationPast(registry, after) {
  for (const started = Date.now(); Date.now() - started < 60_000; await new Promise((r) => setTimeout(r, 100))) {
    if (newestGeneration(registry) > after) return newestGeneration(registry);
  }
  throw new Error(`airprompter dev signed no generation past ${after} within 60 s of a prompt edit: ${registry.state.stderr}`);
}

/** Only what a shell needs to find node and npm, then the addresses this check serves. Nothing of the caller's keys. */
function cleanEnvironment(extra) {
  const keep = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "APPDATA", "LOCALAPPDATA"];
  return { ...Object.fromEntries(keep.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])), ...extra };
}

function check(name, { requests, unexpected }, result, rows, expected, registry) {
  const problems = [];
  const { turns, answer, toolCalls, tokens } = recording();
  // A dead registry reads as "the system text was the caller's own", so it is named first.
  if (registry.state.exited !== null) problems.push(`airprompter dev stopped during the run (${registry.state.exited}): ${registry.state.stderr}`);
  if (result.timedOut) problems.push(`did not exit within ${RUN_TIMEOUT_MS / 1000} s`);
  else if (result.code !== 0) problems.push(`exited ${result.code ?? result.signal}`);
  if (unexpected.length) problems.push(`the provider got calls it does not record: ${JSON.stringify(unexpected)}`);
  if (requests.length !== turns.length) problems.push(`the provider got ${requests.length} model calls; the recorded loop is ${turns.length}`);
  for (const [index, request] of requests.entries()) {
    if (JSON.stringify(request.system) !== JSON.stringify([expected.text])) problems.push(`call ${index + 1}: the system text was ${JSON.stringify(request.system)}, not the approved prompt`);
    if (request.model !== expected.model) problems.push(`call ${index + 1}: the model was ${request.model}, not the release's ${expected.model}`);
    if (!request.tools.includes(TOOL.name)) problems.push(`call ${index + 1}: ${TOOL.name} was not offered (tools: ${request.tools.join(", ") || "none"})`);
  }
  if (!result.stdout.includes(answer)) problems.push(`the agent did not print the recorded answer ${JSON.stringify(answer)}`);
  if (rows.some((row) => row.type === "unreadable")) problems.push("a spool segment holds a line that is not JSON");
  const runs = rows.filter((row) => row.type === "window" && row.count > 0);
  if (runs.length !== 1) problems.push(`the spool holds ${runs.length} run rows; one request is one run: ${JSON.stringify(runs)}`);
  const [row] = runs;
  if (row) {
    const want = { tag: expected.slot, count: 1, agentRun: 1, status: "ok", model: expected.model, modelCalls: turns.length };
    for (const [key, value] of Object.entries(want)) if (row[key] !== value) problems.push(`the run row's ${key} is ${JSON.stringify(row[key])}, not ${JSON.stringify(value)}`);
    if (row.tools?.calls !== toolCalls) problems.push(`the run row counts ${row.tools?.calls} tool calls, not ${toolCalls}`);
    if (row.tokens?.input + (row.tokens?.cachedInput ?? 0) !== tokens.input || row.tokens?.output !== tokens.output) problems.push(`the run row's tokens are ${JSON.stringify(row.tokens)}, not ${JSON.stringify(tokens)}`);
  }
  if (problems.length) {
    console.error(`✗ ${name}\n${problems.map((p) => `  - ${p}`).join("\n")}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`);
    return false;
  }
  console.log(`✓ ${name}: ${requests.length} model calls on the approved prompt and ${expected.model}, ${toolCalls} tool calls, one run (count 1) in the spool`);
  return true;
}

const work = mkdtempSync(join(tmpdir(), "ap-examples-"));
let registry = null;
let ok = true;
/** The registry stopped and the work folder gone, at the end or on Ctrl-C. */
function cleanUp() {
  registry?.stop();
  rmSync(work, { recursive: true, force: true });
}
try {
  const stray = unlisted();
  if (stray.length) throw new Error(`examples/${stray.join(", examples/")} looks like an example but is not in EXAMPLES in examples/ci/run.mjs, so it would never run`);

  let cli = null;
  let tarballs = {};
  let version = null;
  if (!published) {
    console.log("Building the CLI and the SDK from this commit…");
    sh(process.execPath, [join(repo, "cli", "scripts", "bundle.mjs")], join(repo, "cli"));
    sh(npm, ["run", "build"], join(repo, "sdk-typescript"));
    const packed = Object.values(JSON.parse(read(npm, ["pack", "--pack-destination", work, "--json"], join(repo, "sdk-typescript", "packages", "sdk"))))[0];
    const shipped = packed.files.map((file) => file.path).filter((path) => /(^|\/)examples\//.test(path));
    if (shipped.length) throw new Error(`the packed SDK ships ${shipped.join(", ")}: examples/ must add nothing to a published package`);
    tarballs = { "@airprompter/agent-sdk": join(work, packed.filename) };
    version = packed.version;
    cli = [process.execPath, join(repo, "cli", "dist", "airprompter.cjs")];
  }

  cpSync(join(repo, "examples", "prompts"), join(work, "prompts"), { recursive: true, filter: outside(join(repo, "examples", "prompts")) });

  for (const name of names) {
    const example = EXAMPLES[name];
    console.log(`\n${name}${latest ? " (latest framework releases)" : ""}${published ? " (as published)" : ""}`);
    const dir = join(work, name);
    cpSync(join(repo, "examples", name), dir, { recursive: true, filter: outside(join(repo, "examples", name)) });
    const runner = RUNNERS[example.runner];
    if (!runner.install(dir, tarballs, version)) continue;
    // Started once, at the first example that runs: `--published` downloads the CLI only when something needs it.
    registry ??= await startRegistry(cli ?? (await releasedCli(work)), join(work, "prompts"));
    const once = async (label, expected) => {
      const provider = await startFakeProvider();
      const spoolDir = join(work, `spool-${label}`);
      let result;
      try {
        result = await runner.run(dir, cleanEnvironment({
          AIRPROMPTER_AGENT_KEY: registry.facts.apiKey,
          AIRPROMPTER_BASE_URL: registry.facts.baseUrl,
          AIRPROMPTER_SPOOL_DIR: spoolDir,
          // One state folder for both runs, as on a developer's machine: the second starts with a release stored.
          XDG_STATE_HOME: join(work, `state-${name}`),
          OPENAI_BASE_URL: `${provider.url}/v1`,
          OPENAI_API_KEY: "fake-provider-key",
        }));
      } finally {
        await provider.close();
      }
      return check(label, provider, result, windowRows(spoolDir), { ...expected, slot: example.slot }, registry);
    };
    const prompt = join(work, "prompts", example.prompt);
    const original = readFileSync(prompt, "utf8");
    const first = approved(example.prompt);
    if (!(await once(name, first))) {
      ok = false;
      continue;
    }
    // The README's "change the prompt" step: an edit saved while the registry runs is what the next run serves. It
    // passes without the example's `await ap.syncNow()` too, because against a local registry the sync the first
    // heartbeat starts wins the race to the first call; that line is there for a remote service, where it can lose.
    const edited = `Edited while the registry runs. ${first.text}`;
    writeFileSync(prompt, original.replace(first.text, edited));
    const generation = await generationPast(registry, newestGeneration(registry));
    ok = (await once(`${name} after a prompt edit`, { ...first, text: edited })) && ok;
    writeFileSync(prompt, original);
    await generationPast(registry, generation);
  }
} catch (error) {
  console.error(`run.mjs: ${error.message}`);
  ok = false;
} finally {
  cleanUp();
}
process.exit(ok ? 0 : 1);
