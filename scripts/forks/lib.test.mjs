// The fork-tracking rules (AIR-2314): never overwrite or delete a tag, never touch compat/*, compat tags from what a
// release tested.  $ node --test scripts/forks/
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadManifest, npmLockVersion, parseLsRemote, planCompatTags, planTagSync, sdkReleaseTag } from "./lib.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const T = "f".repeat(40);

test("ls-remote: an annotated tag is compared by the commit it names", () => {
  const tags = parseLsRemote(`${T}\trefs/tags/v1.0.0\n${A}\trefs/tags/v1.0.0^{}\n${B}\trefs/tags/v1.1.0\nnot a line\n${C}\trefs/heads/main\n`);
  assert.deepEqual([...tags], [["v1.0.0", A], ["v1.1.0", B]]);
});

test("a sync adds missing tags, reports moved and deleted ones, and leaves compat/* alone", () => {
  const upstream = new Map([["v1", A], ["v2", C], ["v3", B], ["compat/9.9.9", C]]);
  const ours = new Map([["v1", A], ["v2", B], ["v0", A], ["compat/1.0.0", A]]);
  assert.deepEqual(planTagSync(upstream, ours), { add: ["v3"], moved: [{ tag: "v2", ours: B, upstream: C }], deletedUpstream: ["v0"] });
});

test("the manifest lists the twelve forks and two private mirrors of AIR-2314", () => {
  const manifest = loadManifest();
  const forks = manifest.forks.filter((f) => f.kind === "fork").map((f) => f.repo.split("/")[1]).sort();
  assert.deepEqual(forks, ["anthropic-sdk-python", "anthropic-sdk-typescript", "langchain", "langchainjs", "langgraph", "langgraphjs", "openai-agents-js", "openai-agents-python", "openai-node", "openai-python", "pydantic-ai", "vercel-ai"]);
  assert.deepEqual(manifest.forks.filter((f) => f.kind === "private-mirror").map((f) => f.repo).sort(), ["airprompter/litellm", "airprompter/mastra"]);
});

test("the manifest refuses a repository outside the org, a duplicate, and a tag pattern without {version}", () => {
  const dir = mkdtempSync(join(tmpdir(), "forks-manifest-"));
  const write = (forks) => {
    const path = join(dir, `${Math.random()}.json`);
    writeFileSync(path, JSON.stringify({ forks }));
    return path;
  };
  const ok = { repo: "airprompter/x", upstream: "up/x", kind: "fork", branch: "main" };
  assert.throws(() => loadManifest(write([{ ...ok, repo: "someone/x" }])), /not in the airprompter org/);
  assert.throws(() => loadManifest(write([ok, ok])), /listed twice/);
  assert.throws(() => loadManifest(write([{ ...ok, packages: [{ name: "x", tag: "v1" }] }])), /without \{version\}/);
  assert.throws(() => loadManifest(write([{ ...ok, kind: "public-mirror" }])), /kind must be/);
});

test("lockfile versions and release tags", () => {
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/openai": { version: "7.50.0" }, "node_modules/@langchain/core": { version: "1.3.4" } } });
  assert.equal(npmLockVersion(lock, "openai"), "7.50.0");
  assert.equal(npmLockVersion(lock, "@langchain/core"), "1.3.4");
  assert.equal(npmLockVersion(lock, "ai"), null);
  assert.equal(sdkReleaseTag("npm", "1.0.0-rc.4"), "sdk-typescript/v1.0.0-rc.4");
  assert.equal(sdkReleaseTag("pypi", "1.0.0-rc.4"), "sdk-python/v1.0.0-rc.4");
});

test("compat tags: one per fork on the tested commit, per package when a monorepo split, never moved", () => {
  const lock = JSON.stringify({ packages: { "node_modules/one": { version: "1.0.0" }, "node_modules/two": { version: "2.0.0" }, "node_modules/three": { version: "3.0.0" } } });
  const manifest = {
    forks: [
      { repo: "airprompter/same", packages: [{ registry: "npm", name: "one", tag: "one@{version}", testedVersionFrom: "lock" }, { registry: "npm", name: "two", tag: "two@{version}", testedVersionFrom: "lock" }] },
      { repo: "airprompter/split", packages: [{ registry: "npm", name: "one", tag: "one@{version}", testedVersionFrom: "lock" }, { registry: "npm", name: "three", tag: "three@{version}", testedVersionFrom: "lock" }] },
      { repo: "airprompter/tagged", packages: [{ registry: "npm", name: "one", tag: "v{version}", testedVersionFrom: "lock" }] },
      { repo: "airprompter/moved", packages: [{ registry: "npm", name: "one", tag: "v{version}", testedVersionFrom: "lock" }] },
      { repo: "airprompter/untested", packages: [{ registry: "npm", name: "absent", tag: "v{version}", testedVersionFrom: "lock" }, { registry: "pypi", name: "py", tag: "v{version}" }] },
      { repo: "airprompter/unsynced", packages: [{ registry: "npm", name: "one", tag: "v{version}", testedVersionFrom: "lock" }] },
    ],
  };
  const tags = {
    "airprompter/same": new Map([["one@1.0.0", A], ["two@2.0.0", A]]),
    "airprompter/split": new Map([["one@1.0.0", A], ["three@3.0.0", B]]),
    "airprompter/tagged": new Map([["v1.0.0", A], ["compat/1.2.3", A]]),
    "airprompter/moved": new Map([["v1.0.0", A], ["compat/1.2.3", C]]),
    "airprompter/untested": new Map(),
    "airprompter/unsynced": new Map(),
  };
  const reads = [];
  const plan = planCompatTags(manifest, "1.2.3", { readAtTag: (tag, path) => (reads.push(`${tag}:${path}`), lock), forkTags: (repo) => tags[repo] });
  const by = Object.fromEntries(plan.map((entry) => [entry.repo.split("/")[1], entry]));
  assert.ok(reads.every((read) => read === "sdk-typescript/v1.2.3:lock"));
  assert.deepEqual(by.same.tags.map((t) => [t.tag, t.commit, t.state]), [["compat/1.2.3", A, "create"]]);
  assert.deepEqual(by.split.tags.map((t) => [t.tag, t.commit]), [["compat/1.2.3/one", A], ["compat/1.2.3/three", B]]);
  assert.deepEqual(by.tagged.tags.map((t) => t.state), ["present"]);
  assert.deepEqual(by.moved.tags.map((t) => [t.state, t.existing]), [["conflict", C]]);
  assert.deepEqual(by.untested.tags, []);
  assert.match(by.untested.skipped[0].reason, /did not test it/);
  assert.match(by.untested.skipped[1].reason, /nothing certifies it/);
  assert.match(by.unsynced.skipped[0].reason, /sync the fork first/);
});
