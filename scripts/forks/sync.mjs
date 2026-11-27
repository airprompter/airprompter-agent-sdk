#!/usr/bin/env node
/**
 * @fileoverview Keeps the forks and mirrors in `forks/forks.json` tracked against upstream (AIR-2314). It runs from
 * `.github/workflows/sync-forks.yml` on a schedule, because Actions stay off in the forks themselves.
 *
 * For each repository:
 * 1. **Default branch.** A fork goes through GitHub's `merge-upstream`, which fast-forwards it. A private mirror has
 *    no fork link, so the branch is fetched from upstream and pushed without force: a non-fast-forward is refused
 *    and reported.
 * 2. **Tags.** Upstream tags we lack are fetched and pushed. A tag upstream moved or deleted is reported and ours is
 *    kept. While such a change is unacknowledged, that repository gets no new tags: the sync stops and reports
 *    instead of guessing. Acknowledge a change by listing the tag under `acknowledgedTagChanges` for that repository
 *    in `forks/forks.json`. `compat/*` tags are ours and never touched.
 *
 * Exit 0 when every repository synced cleanly or only acknowledged changes remain; exit 1 otherwise. A Markdown
 * report goes to `$GITHUB_STEP_SUMMARY` when set, and JSON to stdout.
 *
 * The token (`FORK_SYNC_TOKEN`) needs Contents: write on every repository listed, and Workflows: write, because a
 * fast-forward can bring upstream's own `.github/workflows` changes. It is read from the environment only and is
 * never printed.
 *
 *   $ FORK_SYNC_TOKEN=… node scripts/forks/sync.mjs                    # sync every repository
 *   $ node scripts/forks/sync.mjs --dry-run                            # plan only; no token: public forks only
 *   $ FORK_SYNC_TOKEN=… node scripts/forks/sync.mjs --only airprompter/langgraphjs
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { github, gitUrl, loadManifest, lsRemoteTags, planTagSync, tagGate } from "./lib.mjs";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const token = process.env.FORK_SYNC_TOKEN?.trim() || "";
const BATCH = 200;
const log = (line) => process.stderr.write(`[sync-forks] ${line}\n`);

if (!dryRun && !token) {
  log("FORK_SYNC_TOKEN is not set. It needs Contents: write and Workflows: write on every repository in forks/forks.json.");
  process.exit(2);
}

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
// A failed git command's message can quote the remote URL, which carries the token.
const redact = (text) => (token ? String(text).replaceAll(token, "***") : String(text));

async function syncBranch(fork, work) {
  if (dryRun) return { status: "skipped (dry run)" };
  if (fork.kind === "fork") {
    try {
      // merge-upstream writes a merge commit when our branch has commits upstream lacks. We never change the forks'
      // code, so a fork that is ahead is reported, not merged.
      const upstreamOwner = fork.upstream.split("/")[0];
      const compare = await github("GET", `/repos/${fork.repo}/compare/${upstreamOwner}:${encodeURIComponent(fork.branch)}...${encodeURIComponent(fork.branch)}`, token);
      if (compare.ahead_by > 0) return { status: "not synced: ours is ahead of upstream", problem: true, message: `${fork.repo} ${fork.branch} has ${compare.ahead_by} commit(s) upstream lacks (forks/README.md › When the sync fails)` };
      const result = await github("POST", `/repos/${fork.repo}/merge-upstream`, token, { branch: fork.branch });
      if (result.merge_type === "merge") return { status: "merged, NOT a fast-forward", problem: true, message: result.message };
      return { status: result.merge_type === "none" ? "up to date" : result.merge_type, message: result.message };
    } catch (error) {
      // 409: upstream rewrote its history, or the branches conflict.
      return { status: "failed", problem: true, message: redact(error.message) };
    }
  }
  try {
    git(work, ["fetch", "--quiet", "--filter=blob:none", "--no-tags", "upstream", `+refs/heads/${fork.branch}:refs/remotes/upstream/${fork.branch}`]);
    git(work, ["push", "--quiet", "ours", `refs/remotes/upstream/${fork.branch}:refs/heads/${fork.branch}`]);
    return { status: "pushed (fast-forward or already there)" };
  } catch (error) {
    return { status: "failed", problem: true, message: redact(error.stderr || error.message).split("\n").slice(-4).join(" ") };
  }
}

function pushTags(work, tags) {
  for (let i = 0; i < tags.length; i += BATCH) {
    const batch = tags.slice(i, i + BATCH);
    git(work, ["fetch", "--quiet", "--filter=blob:none", "--no-tags", "upstream", ...batch.map((tag) => `refs/tags/${tag}:refs/tags/${tag}`)]);
    // No force: a tag that appeared on ours since the plan is refused, never overwritten.
    git(work, ["push", "--quiet", "ours", ...batch.map((tag) => `refs/tags/${tag}:refs/tags/${tag}`)]);
  }
}

async function syncOne(fork) {
  const report = { repo: fork.repo, upstream: fork.upstream, kind: fork.kind };
  if (fork.kind === "private-mirror" && !token) return { ...report, branch: { status: "skipped: a private mirror needs FORK_SYNC_TOKEN" }, tags: null };
  const work = mkdtempSync(join(tmpdir(), "sync-forks-"));
  try {
    git(work, ["init", "--quiet", "--bare"]);
    git(work, ["remote", "add", "upstream", gitUrl(fork.upstream)]);
    git(work, ["remote", "add", "ours", gitUrl(fork.repo, token)]);
    report.branch = await syncBranch(fork, work);
    const plan = planTagSync(lsRemoteTags(gitUrl(fork.upstream)), lsRemoteTags(gitUrl(fork.repo, token)));
    const { open, push } = tagGate(plan, fork.acknowledgedTagChanges);
    report.tags = { toAdd: plan.add.length, moved: plan.moved, deletedUpstream: plan.deletedUpstream, unacknowledged: open, added: 0 };
    if (open.length > 0) {
      report.tags.stopped = `paused: upstream moved or deleted ${open.join(", ")}. Ours are kept; no tags were added. To accept, add ${JSON.stringify(open)} to acknowledgedTagChanges for ${fork.repo} in forks/forks.json (forks/README.md › When the sync fails).`;
    } else if (push.length > 0 && !dryRun) {
      pushTags(work, push);
      report.tags.added = push.length;
    }
    report.problem = Boolean(report.branch?.problem || open.length > 0);
    return report;
  } catch (error) {
    return { ...report, problem: true, error: redact(error.stderr || error.message).split("\n").slice(-4).join(" ") };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const manifest = loadManifest();
const forks = manifest.forks.filter((fork) => !only || fork.repo === only);
if (forks.length === 0) {
  log(`no repository ${only} in forks/forks.json`);
  process.exit(2);
}
const reports = [];
for (const fork of forks) {
  log(`${fork.repo} ← ${fork.upstream}`);
  const report = await syncOne(fork);
  log(`  branch: ${report.branch?.status ?? "-"}; tags: ${report.tags ? `${dryRun ? "would add" : "added"} ${dryRun ? report.tags.toAdd : report.tags.added}, moved ${report.tags.moved.length}, deleted upstream ${report.tags.deletedUpstream.length}` : "-"}${report.error ? `; error: ${report.error}` : ""}`);
  reports.push(report);
}

const failed = reports.filter((report) => report.problem);
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = reports.map((r) => `| ${r.repo} | ${r.branch?.status ?? "-"} | ${r.tags ? (dryRun ? r.tags.toAdd : r.tags.added) : "-"} | ${r.tags?.moved.map((m) => `${m.tag} (${m.ours.slice(0, 7)}→${m.upstream.slice(0, 7)})`).join(", ") || "-"} | ${r.tags?.deletedUpstream.join(", ") || "-"} | ${r.error ?? r.tags?.stopped ?? r.branch?.message ?? ""} |`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [`## Fork sync${dryRun ? " (dry run)" : ""}`, "", "| Repository | Default branch | Tags added | Moved upstream | Deleted upstream | Note |", "|---|---|---|---|---|---|", ...rows, ""].join("\n"));
}
process.stdout.write(`${JSON.stringify({ dryRun, ok: failed.length === 0, reports })}\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
