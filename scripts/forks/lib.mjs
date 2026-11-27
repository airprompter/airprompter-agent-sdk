/**
 * @fileoverview Shared logic for keeping the agent SDK forks tracked (AIR-2314). `forks/forks.json` lists them;
 * `sync.mjs` and `compat-tags.mjs` call these functions. They are pure where they can be, so the rules are tested
 * without GitHub:
 *
 * - **Tags are never overwritten or deleted.** A tag upstream moved, or deleted, is reported and ours is kept as it is.
 * - **`compat/*` is ours.** No sync touches it. An SDK release adds `compat/<sdk version>` and never moves one.
 * - **A tag compares by the commit it names** (the peeled `^{}` line for an annotated tag), so re-creating an
 *   annotated tag on the same commit is not reported as moved.
 *
 * Plain Node, no dependencies.
 *
 * @example
 * ```js
 * import { parseLsRemote, planTagSync } from "./lib.mjs";
 * const plan = planTagSync(parseLsRemote(upstreamText), parseLsRemote(oursText));
 * // { add: ["v1.2.0"], moved: [{ tag: "v1.1.0", ours: "aaa…", upstream: "bbb…" }], deletedUpstream: ["v0.9.0"] }
 * ```
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const COMPAT_PREFIX = "compat/";

/** `forks/forks.json`, checked enough that a typo fails loudly instead of syncing the wrong repository. */
export function loadManifest(path = join(REPO_ROOT, "forks", "forks.json")) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(manifest.forks) || manifest.forks.length === 0) throw new Error(`${path}: no forks listed`);
  const seen = new Set();
  for (const fork of manifest.forks) {
    for (const field of ["repo", "upstream", "kind", "branch"]) if (typeof fork[field] !== "string" || !fork[field]) throw new Error(`${path}: ${fork.repo ?? "a fork"} has no ${field}`);
    if (!/^airprompter\/[A-Za-z0-9._-]+$/.test(fork.repo)) throw new Error(`${path}: ${fork.repo} is not in the airprompter org`);
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(fork.upstream)) throw new Error(`${path}: ${fork.repo} has an upstream that is not owner/name`);
    if (fork.kind !== "fork" && fork.kind !== "private-mirror") throw new Error(`${path}: ${fork.repo} kind must be fork or private-mirror`);
    if (seen.has(fork.repo)) throw new Error(`${path}: ${fork.repo} is listed twice`);
    seen.add(fork.repo);
    if (fork.ignoreTags !== undefined && !(Array.isArray(fork.ignoreTags) && fork.ignoreTags.every((tag) => typeof tag === "string" && tag && !tag.startsWith(COMPAT_PREFIX)))) throw new Error(`${path}: ${fork.repo} ignoreTags must be tag names (never compat/*)`);
    for (const entry of fork.acknowledgedTagChanges ?? []) {
      if (typeof entry?.tag !== "string" || !(entry.upstream === null || /^[0-9a-f]{40,64}$/.test(entry.upstream ?? ""))) throw new Error(`${path}: ${fork.repo} acknowledgedTagChanges entries are { "tag": …, "upstream": "<commit upstream now names>" | null }`);
    }
    for (const pkg of fork.packages ?? []) {
      if (pkg.registry !== "npm" && pkg.registry !== "pypi") throw new Error(`${path}: ${fork.repo} ${pkg.name} registry must be npm or pypi`);
      if (!pkg.tag?.includes("{version}")) throw new Error(`${path}: ${fork.repo} ${pkg.name} has a tag without {version}`);
      // Only npm lockfiles have a reader. A Python one would read as "not tested", which is false (forks/README.md).
      if (pkg.registry === "pypi" && pkg.testedVersionFrom) throw new Error(`${path}: ${fork.repo} ${pkg.name}: no reader for a Python testedVersionFrom yet (forks/README.md › How a Python version gets certified)`);
    }
  }
  return manifest;
}

/**
 * `git ls-remote --tags` output → Map(tag → commit). An annotated tag's peeled line (`refs/tags/x^{}`) wins over
 * the tag object's own line, so the value is always the commit the tag names.
 */
export function parseLsRemote(text) {
  const tags = new Map();
  const peeled = new Map();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{40,64})\trefs\/tags\/(.+)$/.exec(line.trim());
    if (!match) continue;
    const [, sha, ref] = match;
    if (ref.endsWith("^{}")) peeled.set(ref.slice(0, -3), sha);
    else tags.set(ref, sha);
  }
  for (const [tag, sha] of peeled) tags.set(tag, sha);
  return tags;
}

/**
 * What a sync does with tags: add the upstream tags we lack; report a tag upstream now points elsewhere (`moved`)
 * and one we hold that upstream no longer has (`deletedUpstream`). Ours stay as they are in both cases, and
 * `compat/*` is never compared, added or reported. `ignoreTags` names floating pointers (a nightly, `*-bleeding`)
 * that move on every build: never copied, compared or reported.
 */
export function planTagSync(upstream, ours, ignoreTags = []) {
  const ignored = new Set(ignoreTags);
  const add = [];
  const moved = [];
  const deletedUpstream = [];
  for (const [tag, sha] of upstream) {
    if (tag.startsWith(COMPAT_PREFIX) || ignored.has(tag)) continue;
    const mine = ours.get(tag);
    if (mine === undefined) add.push(tag);
    else if (mine !== sha) moved.push({ tag, ours: mine, upstream: sha });
  }
  for (const tag of ours.keys()) if (!tag.startsWith(COMPAT_PREFIX) && !ignored.has(tag) && !upstream.has(tag)) deletedUpstream.push(tag);
  return { add: add.sort(), moved: moved.sort((a, b) => a.tag.localeCompare(b.tag)), deletedUpstream: deletedUpstream.sort() };
}

/**
 * The ticket's rule: while a moved or deleted upstream tag is not acknowledged, the repository gets no new tags.
 * An acknowledgement accepts one change only: `{ tag, upstream }` names the commit upstream moved it to, or
 * `upstream: null` for a deletion, so a later move of the same tag is reported again. `open` still needs a person;
 * `push` is what the sync may add.
 */
export function tagGate(plan, acknowledged = []) {
  const ack = new Set(acknowledged.map((entry) => `${entry.tag}\u0000${entry.upstream ?? ""}`));
  const open = [...plan.moved.map((entry) => ({ tag: entry.tag, upstream: entry.upstream })), ...plan.deletedUpstream.map((tag) => ({ tag, upstream: null }))]
    .filter((change) => !ack.has(`${change.tag}\u0000${change.upstream ?? ""}`))
    .map((change) => change.tag);
  return { open, push: open.length > 0 ? [] : plan.add };
}

/** The version of `name` an npm lockfile (v2/v3) installed at the top level, or null. */
export function npmLockVersion(lockText, name) {
  const lock = JSON.parse(lockText);
  return lock.packages?.[`node_modules/${name}`]?.version ?? lock.dependencies?.[name]?.version ?? null;
}

/** The release tag that certifies a package of this registry: TypeScript and Python SDKs are tagged separately. */
export function sdkReleaseTag(registry, sdkVersion) {
  return registry === "npm" ? `sdk-typescript/v${sdkVersion}` : `sdk-python/v${sdkVersion}`;
}

/**
 * The `compat/<sdk version>` tags one SDK release adds, from what it tested:
 * - `readAtTag(tag, path)` returns a file at a release tag of this repository, or null;
 * - `forkTags(repo)` returns Map(tag → commit) for our fork.
 * `registry` (`npm` or `pypi`) limits the plan to one SDK's packages, so the two release runs never race on a tag.
 * One tag per fork when every tested package of it resolves to one commit; `compat/<sdk>/<package>` per package
 * when a monorepo released them from different commits. Each entry says why it is or is not tagged.
 */
export function planCompatTags(manifest, sdkVersion, { readAtTag, forkTags, registry = null }) {
  const entries = [];
  for (const fork of manifest.forks) {
    const resolved = [];
    const skipped = [];
    let ours = null;
    for (const pkg of (fork.packages ?? []).filter((candidate) => !registry || candidate.registry === registry)) {
      if (!pkg.testedVersionFrom) {
        skipped.push({ package: pkg.name, reason: "no tested version is pinned for this package (nothing certifies it)" });
        continue;
      }
      const releaseTag = sdkReleaseTag(pkg.registry, sdkVersion);
      const file = readAtTag(releaseTag, pkg.testedVersionFrom);
      if (file === null) {
        skipped.push({ package: pkg.name, reason: `${pkg.testedVersionFrom} not found at ${releaseTag}` });
        continue;
      }
      const version = pkg.registry === "npm" ? npmLockVersion(file, pkg.name) : null;
      if (!version) {
        skipped.push({ package: pkg.name, reason: `not installed at ${releaseTag} (${pkg.testedVersionFrom}), so the release did not test it` });
        continue;
      }
      const upstreamTag = pkg.tag.replaceAll("{version}", version);
      ours ??= forkTags(fork.repo);
      const commit = ours.get(upstreamTag);
      if (!commit) {
        skipped.push({ package: pkg.name, version, missingOnFork: true, reason: `${fork.repo} has no tag ${upstreamTag}: sync the fork first` });
        continue;
      }
      resolved.push({ package: pkg.name, version, upstreamTag, commit });
    }
    const commits = new Set(resolved.map((entry) => entry.commit));
    const tags = commits.size <= 1
      ? resolved.length ? [{ tag: `${COMPAT_PREFIX}${sdkVersion}`, commit: resolved[0].commit, covers: resolved }] : []
      : resolved.map((entry) => ({ tag: `${COMPAT_PREFIX}${sdkVersion}/${entry.package}`, commit: entry.commit, covers: [entry] }));
    for (const tag of tags) {
      ours ??= forkTags(fork.repo);
      const existing = ours.get(tag.tag);
      // Git cannot hold both compat/X and compat/X/<package>: a ref cannot also be a folder.
      const clash = [...ours.keys()].find((name) => name.startsWith(`${tag.tag}/`) || (tag.tag.startsWith(`${COMPAT_PREFIX}${sdkVersion}/`) && name === `${COMPAT_PREFIX}${sdkVersion}`));
      tag.state = existing === undefined ? (clash ? "conflict" : "create") : existing === tag.commit ? "present" : "conflict";
      if (tag.state === "conflict") tag.existing = existing ?? `${clash} (a ref/folder clash)`;
    }
    entries.push({ repo: fork.repo, tags, skipped });
  }
  return entries;
}

/** `git ls-remote --tags <url>`, parsed. The URL may carry a token; it is never printed. */
export function lsRemoteTags(url) {
  try {
    return parseLsRemote(execFileSync("git", ["ls-remote", "--tags", url], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }));
  } catch (error) {
    // The URL may carry the token; say which repository without it.
    throw new Error(`git ls-remote ${url.replace(/\/\/[^@/]+@/, "//")} failed: ${String(error.stderr || error.message).replace(/\/\/[^@/\s]+@/g, "//").trim().split("\n").pop()}`);
  }
}

/** An https URL for a repository, with the token when one is given (for pushes and private mirrors). */
export function gitUrl(repo, token) {
  return token ? `https://x-access-token:${token}@github.com/${repo}.git` : `https://github.com/${repo}.git`;
}

/** One GitHub REST call with the sync token. Throws with the status and GitHub's message on a non-2xx answer. */
export async function github(method, path, token, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(`${method} ${path}: HTTP ${response.status} ${json?.message ?? text.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }
  return json;
}
