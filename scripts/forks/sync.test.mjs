// sync.mjs end to end against local bare repositories: fast-forward only, new tags added, a moved tag stops the
// repository, ours are never overwritten, compat/* is never touched.  $ node --test scripts/forks/sync.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SYNC = join(dirname(fileURLToPath(import.meta.url)), "sync.mjs");
const COMPAT = join(dirname(fileURLToPath(import.meta.url)), "compat-tags.mjs");
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function world() {
  const root = mkdtempSync(join(tmpdir(), "sync-forks-test-"));
  const base = join(root, "remotes");
  for (const owner of ["up", "airprompter"]) mkdirSync(join(base, owner), { recursive: true });
  const upstream = join(base, "up", "lib.git");
  const ours = join(base, "airprompter", "lib.git");
  git(root, "init", "--quiet", "--bare", upstream);
  const clone = join(root, "work");
  git(root, "clone", "--quiet", upstream, clone);
  const commit = (message) => {
    writeFileSync(join(clone, "file.txt"), `${message}\n`);
    git(clone, "add", "file.txt");
    git(clone, "commit", "--quiet", "-m", message);
    return git(clone, "rev-parse", "HEAD");
  };
  const first = commit("one");
  git(clone, "tag", "v1");
  git(clone, "push", "--quiet", "origin", "main", "v1");
  git(root, "clone", "--quiet", "--bare", upstream, ours);
  const manifest = join(root, "forks.json");
  const writeManifest = (extra = {}) => writeFileSync(manifest, JSON.stringify({ forks: [{ repo: "airprompter/lib", upstream: "up/lib", kind: "fork", branch: "main", ...extra }] }));
  writeManifest();
  // GitHub's answer to GET /repos/<mirror>, for the private-mirror check.
  const githubStub = (answer) => {
    const path = join(root, `github-${Math.random()}.mjs`);
    writeFileSync(path, `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(answer))}, { status: 200, headers: { "content-type": "application/json" } });\n`);
    return path;
  };
  const run = (stub = null) => {
    const result = spawnSync("node", [...(stub ? ["--import", stub] : []), SYNC], { encoding: "utf8", env: { ...process.env, FORK_SYNC_GIT_BASE: base, FORK_SYNC_MANIFEST: manifest, FORK_SYNC_TOKEN: "test-token", GITHUB_STEP_SUMMARY: "" } });
    return { status: result.status, report: JSON.parse(result.stdout.trim().split("\n").pop()).reports[0], stderr: result.stderr };
  };
  const refs = (repo) => Object.fromEntries(git(root, "ls-remote", repo).split("\n").filter(Boolean).map((line) => line.split("\t").reverse()));
  return { root, clone, upstream, ours, commit, first, run, refs, writeManifest, githubStub };
}

test("fast-forwards the branch and adds new tags; compat/* and ours stay", () => {
  const w = world();
  git(w.root, "--git-dir", w.ours, "tag", "compat/1.0.0", w.first);
  const second = w.commit("two");
  git(w.clone, "tag", "v2");
  git(w.clone, "push", "--quiet", "origin", "main", "v2");
  const { status, report } = w.run();
  assert.equal(status, 0, JSON.stringify(report));
  assert.equal(report.branch.status, "fast-forwarded");
  assert.equal(report.tags.added, 1);
  const ours = w.refs(w.ours);
  assert.equal(ours["refs/heads/main"], second);
  assert.equal(ours["refs/tags/v2"], second);
  assert.equal(ours["refs/tags/compat/1.0.0"], w.first);
  assert.equal(w.run().report.branch.status, "up to date");
});

test("a moved upstream tag stops that repository's tags until that exact move is acknowledged; ours is kept", () => {
  const w = world();
  const second = w.commit("two");
  git(w.clone, "tag", "-f", "v1");
  git(w.clone, "tag", "v2");
  git(w.clone, "push", "--quiet", "--force", "origin", "main", "v1", "v2");
  const stopped = w.run();
  assert.equal(stopped.status, 1);
  assert.deepEqual(stopped.report.tags.unacknowledged, ["v1"]);
  assert.equal(stopped.report.tags.added, 0);
  assert.equal(w.refs(w.ours)["refs/tags/v1"], w.first, "ours is never overwritten");
  assert.equal(w.refs(w.ours)["refs/tags/v2"], undefined, "no new tags while a change is open");
  w.writeManifest({ acknowledgedTagChanges: [{ tag: "v1", upstream: second }] });
  const accepted = w.run();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(w.refs(w.ours)["refs/tags/v1"], w.first, "acknowledged, still ours");
  assert.equal(w.refs(w.ours)["refs/tags/v2"], second);
});

test("a branch that diverged is refused, never merged or forced", () => {
  const w = world();
  const scratch = join(w.root, "ours-work");
  git(w.root, "clone", "--quiet", w.ours, scratch);
  writeFileSync(join(scratch, "ours.txt"), "ours\n");
  git(scratch, "add", "ours.txt");
  git(scratch, "commit", "--quiet", "-m", "ours");
  git(scratch, "push", "--quiet", "origin", "main");
  const oursHead = git(scratch, "rev-parse", "HEAD");
  w.commit("two");
  git(w.clone, "push", "--quiet", "origin", "main");
  const { status, report } = w.run();
  assert.equal(status, 1);
  assert.equal(report.branch.status, "not a fast-forward");
  assert.equal(w.refs(w.ours)["refs/heads/main"], oursHead);
});

test("a private mirror is pushed to only while GitHub confirms it is private", () => {
  const w = world();
  w.writeManifest({ kind: "private-mirror" });
  const second = w.commit("two");
  git(w.clone, "tag", "v2");
  git(w.clone, "push", "--quiet", "origin", "main", "v2");
  const before = w.refs(w.ours);
  const refused = w.run(w.githubStub({ private: false }));
  assert.equal(refused.status, 1);
  assert.equal(refused.report.branch.status, "refused: the mirror is public");
  assert.deepEqual(w.refs(w.ours), before, "neither the branch nor any tag reached a public mirror");
  const synced = w.run(w.githubStub({ private: true }));
  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(w.refs(w.ours)["refs/heads/main"], second);
  assert.equal(w.refs(w.ours)["refs/tags/v2"], second);
});

test("a push GitHub refuses keeps git's own message, not a false 'not a fast-forward'", () => {
  const w = world();
  writeFileSync(join(w.ours, "hooks", "pre-receive"), "#!/bin/sh\necho 'refusing to allow a token to update .github/workflows/ci.yml without workflow scope' >&2\nexit 1\n", { mode: 0o755 });
  w.commit("two");
  git(w.clone, "push", "--quiet", "origin", "main");
  const { status, report } = w.run();
  assert.equal(status, 1);
  assert.equal(report.branch.status, "failed");
  assert.match(report.branch.message, /declined|workflow scope/);
  assert.match(report.branch.message, /Workflows: read and write/);
});

test("without FORK_SYNC_TOKEN: the scheduled sync is a notice and exit 0; a run started by hand fails", () => {
  const w = world();
  const report = join(w.root, "report.json");
  const env = { ...process.env, FORK_SYNC_GIT_BASE: join(w.root, "remotes"), FORK_SYNC_MANIFEST: join(w.root, "forks.json"), FORK_SYNC_TOKEN: "", GITHUB_STEP_SUMMARY: "" };
  const before = w.refs(w.ours);
  w.commit("two");
  git(w.clone, "push", "--quiet", "origin", "main");
  const scheduled = spawnSync("node", [SYNC, "--skip-without-token", "--report", report], { encoding: "utf8", env });
  assert.equal(scheduled.status, 0, scheduled.stderr);
  assert.match(scheduled.stdout, /^::notice title=Fork sync is waiting on FORK_SYNC_TOKEN::.*Owner setup/m);
  assert.equal(JSON.parse(readFileSync(report, "utf8")).skipped, "FORK_SYNC_TOKEN is not set");
  assert.deepEqual(w.refs(w.ours), before, "nothing is pushed");
  const byHand = spawnSync("node", [SYNC], { encoding: "utf8", env });
  assert.equal(byHand.status, 2);
  assert.match(byHand.stderr, /FORK_SYNC_TOKEN is not set/);
});

test("without FORK_SYNC_TOKEN: the release's compat-tags step is a notice naming the planned tags and how to create them", () => {
  const w = world();
  // A repository of our own with a release tag whose lockfile installed one package, and a fork that holds its tag.
  const repo = join(w.root, "sdk");
  mkdirSync(join(repo, "sdk-typescript"), { recursive: true });
  git(w.root, "init", "--quiet", repo);
  writeFileSync(join(repo, "sdk-typescript", "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/lib": { version: "1.0.0" } } }));
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "release");
  git(repo, "tag", "sdk-typescript/v9.9.9");
  writeFileSync(join(w.root, "forks.json"), JSON.stringify({ forks: [{ repo: "airprompter/lib", upstream: "up/lib", kind: "fork", branch: "main", packages: [{ registry: "npm", name: "lib", tag: "v{version}", testedVersionFrom: "sdk-typescript/package-lock.json" }] }] }));
  git(w.clone, "tag", "v1.0.0", w.first);
  git(w.clone, "push", "--quiet", "origin", "v1.0.0");
  git(w.root, "--git-dir", w.ours, "fetch", "--quiet", w.upstream, "refs/tags/v1.0.0:refs/tags/v1.0.0");
  const env = { ...process.env, FORK_SYNC_GIT_BASE: join(w.root, "remotes"), FORK_SYNC_MANIFEST: join(w.root, "forks.json"), FORK_SYNC_REPO_ROOT: repo, FORK_SYNC_TOKEN: "", GITHUB_STEP_SUMMARY: "" };
  const skipped = spawnSync("node", [COMPAT, "9.9.9", "--registry", "npm", "--apply", "--skip-without-token"], { encoding: "utf8", env });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(skipped.stdout, /^::notice title=No compat tags for 9\.9\.9::.*planned: compat\/9\.9\.9 on 1 fork.*compat-tags\.mjs 9\.9\.9 --registry npm --apply/m);
  assert.equal(w.refs(w.ours)["refs/tags/compat/9.9.9"], undefined, "nothing is created");
  const strict = spawnSync("node", [COMPAT, "9.9.9", "--registry", "npm", "--apply"], { encoding: "utf8", env });
  assert.equal(strict.status, 2, "without the flag, a missing token with tags to create is an error");
});
