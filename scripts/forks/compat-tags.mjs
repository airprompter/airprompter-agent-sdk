#!/usr/bin/env node
/**
 * @fileoverview Tags each fork at the version an SDK release tested, as `compat/<sdk version>` (AIR-2314).
 *
 * For every package in `forks/forks.json` with a `testedVersionFrom`, it reads the version that file pins at the SDK
 * release tag (`sdk-typescript/v<version>` for npm packages, `sdk-python/v<version>` for PyPI), finds the upstream's
 * own tag for that version on our fork, and plans `compat/<sdk version>` on that commit. A monorepo whose tested
 * packages came from different commits gets `compat/<sdk version>/<package>` per package. An existing compat tag is
 * never moved: the same commit is "present", any other commit is a "conflict" and the run fails.
 *
 * Without `--apply` it only prints the plan (read-only, no token needed for public forks). With `--apply` it creates
 * the planned tags through the GitHub API with `FORK_SYNC_TOKEN` (Contents: write). Those tags are lightweight and point
 * at commits the fork already holds. `release.yml` runs it with `--apply` after a TypeScript or Python SDK publish.
 *
 *   $ node scripts/forks/compat-tags.mjs 1.0.0-rc.4                    # the plan on stderr, JSON on stdout
 *   $ FORK_SYNC_TOKEN=… node scripts/forks/compat-tags.mjs 1.0.0-rc.4 --registry npm --apply   # what release.yml runs
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { github, gitUrl, loadManifest, lsRemoteTags, planCompatTags, REPO_ROOT } from "./lib.mjs";

const argv = process.argv.slice(2);
const sdkVersion = argv.find((arg, i) => !arg.startsWith("--") && argv[i - 1] !== "--registry");
const apply = argv.includes("--apply");
const registry = argv.includes("--registry") ? argv[argv.indexOf("--registry") + 1] : null;
const token = process.env.FORK_SYNC_TOKEN?.trim() || "";
const log = (line) => process.stderr.write(`[compat-tags] ${line}\n`);

if (!sdkVersion || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(sdkVersion)) {
  log("usage: node scripts/forks/compat-tags.mjs <sdk version, e.g. 1.0.0-rc.4> [--apply]");
  process.exit(2);
}
if (registry !== null && registry !== "npm" && registry !== "pypi") {
  log("--registry is npm (the TypeScript SDK's packages) or pypi (the Python SDK's)");
  process.exit(2);
}


const show = (tag, path) => {
  try {
    return execFileSync("git", ["show", `refs/tags/${tag}:${path}`], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};
// A Python release tag may carry the PEP 440 form (sdk-python/v1.0.0rc4) instead of 1.0.0-rc.4: try both.
const pep440 = (tag) => tag.replace(/-rc\.(\d+)$/, "rc$1").replace(/-beta\.(\d+)$/, "b$1").replace(/-alpha\.(\d+)$/, "a$1");
const readAtTag = (tag, path) => show(tag, path) ?? (tag.startsWith("sdk-python/") ? show(pep440(tag), path) : null);
const forkTagsCache = new Map();
const forkTags = (repo) => {
  if (!forkTagsCache.has(repo)) forkTagsCache.set(repo, lsRemoteTags(gitUrl(repo, token)));
  return forkTagsCache.get(repo);
};

const manifest = loadManifest();
const plan = planCompatTags(manifest, sdkVersion, { readAtTag, forkTags, registry });
const conflicts = plan.flatMap((entry) => entry.tags.filter((tag) => tag.state === "conflict").map((tag) => ({ repo: entry.repo, ...tag })));

for (const entry of plan) {
  for (const tag of entry.tags) log(`${entry.repo}  ${tag.tag} → ${tag.commit.slice(0, 12)}  [${tag.state}]  (${tag.covers.map((c) => `${c.package} ${c.version} = ${c.upstreamTag}`).join("; ")})`);
  for (const skip of entry.skipped) log(`${entry.repo}  not tagged: ${skip.package}${skip.version ? ` ${skip.version}` : ""}: ${skip.reason}`);
}

// A token is needed only when there is something to create (the Python leg plans nothing today).
const toCreate = plan.flatMap((entry) => entry.tags.filter((tag) => tag.state === "create"));
if (apply && toCreate.length > 0 && !token) {
  log(`--apply has ${toCreate.length} tag(s) to create and needs FORK_SYNC_TOKEN (Contents: write on those forks).`);
  process.exit(2);
}
const created = [];
if (apply && conflicts.length === 0) {
  for (const entry of plan) {
    for (const tag of entry.tags.filter((t) => t.state === "create")) {
      await github("POST", `/repos/${entry.repo}/git/refs`, token, { ref: `refs/tags/${tag.tag}`, sha: tag.commit });
      created.push(`${entry.repo} ${tag.tag}`);
      log(`created ${entry.repo} ${tag.tag}`);
    }
  }
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = plan.flatMap((entry) => [
    ...entry.tags.map((tag) => `| ${entry.repo} | \`${tag.tag}\` | ${tag.covers.map((c) => `${c.package} ${c.version} (\`${c.upstreamTag}\`)`).join(", ")} | \`${tag.commit.slice(0, 12)}\` | ${tag.state} |`),
    ...entry.skipped.map((skip) => `| ${entry.repo} | — | ${skip.package} | — | ${skip.reason} |`),
  ]);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [`## compat tags for SDK ${sdkVersion}${apply ? "" : " (plan)"}`, "", "| Fork | Tag | Tested | Commit | State |", "|---|---|---|---|---|", ...rows, ""].join("\n"));
}
process.stdout.write(`${JSON.stringify({ sdkVersion, apply, conflicts, created, plan })}\n`);
if (conflicts.length > 0) log(`${conflicts.length} compat tag(s) already exist on another commit; nothing was created. Compat tags are never moved.`);
// A tested version whose upstream tag our fork does not hold yet would silently get no compat tag: fail instead.
const unsynced = plan.flatMap((entry) => entry.skipped.filter((skip) => skip.missingOnFork).map((skip) => `${entry.repo} (${skip.package} ${skip.version})`));
if (unsynced.length > 0) log(`${unsynced.length} tested version(s) have no upstream tag on our fork yet: ${unsynced.join(", ")}. Run "Sync the agent SDK forks" with only=<repo> (forks/README.md › When the sync fails), then re-run this. Tags already created show as "present".`);
process.exitCode = conflicts.length > 0 || unsynced.length > 0 ? 1 : 0;
