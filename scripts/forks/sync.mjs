#!/usr/bin/env node
/**
 * @fileoverview Keeps the forks and mirrors in `forks/forks.json` tracked against upstream (AIR-2314). It runs from
 * `.github/workflows/sync-forks.yml` on a schedule, because Actions stay off in the forks themselves.
 *
 * For each repository:
 * 1. **Default branch, fast-forward only.** Upstream's branch and ours are fetched and upstream's is pushed without
 *    force, the same way for forks and mirrors: a branch that has diverged is refused and reported, never merged. A
 *    private mirror that has turned public is not pushed to at all.
 * 2. **Tags.** Upstream tags we lack are fetched and pushed. A tag upstream moved or deleted is reported and ours is
 *    kept. While such a change is unacknowledged, that repository gets no new tags: the sync stops and reports
 *    instead of guessing. Acknowledge one change under `acknowledgedTagChanges` (`{ tag, upstream }`) in
 *    `forks/forks.json`; list a floating pointer under `ignoreTags`. `compat/*` tags are ours and never touched.
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
 *   $ node scripts/forks/sync.mjs --skip-without-token --report sync-report.json   # the scheduled run: no token, a notice, exit 0
 */

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { github, gitUrl, loadManifest, lsRemoteTags, planTagSync, tagGate } from "./lib.mjs";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const reportPath = argv.includes("--report") ? argv[argv.indexOf("--report") + 1] : null;
const skipWithoutToken = argv.includes("--skip-without-token");
const token = process.env.FORK_SYNC_TOKEN?.trim() || "";
const BATCH = 200;
const log = (line) => process.stderr.write(`[sync-forks] ${line}\n`);

if (!dryRun && !token) {
  const why = "FORK_SYNC_TOKEN is not set, so no fork was synced. It needs Contents: write and Workflows: write on every repository in forks/forks.json (forks/README.md › Owner setup).";
  if (skipWithoutToken) {
    // The scheduled run: waiting on the owner's token is not a failure. Only the secret's absence is tested, never its value.
    process.stdout.write(`::notice title=Fork sync is waiting on FORK_SYNC_TOKEN::${why}\n`);
    if (reportPath) writeFileSync(reportPath, `${JSON.stringify({ dryRun, ok: true, skipped: "FORK_SYNC_TOKEN is not set", reports: [] })}\n`);
    process.exit(0);
  }
  log(why);
  process.exit(2);
}

// 15 minutes per git command: a hung fetch fails that repository instead of the whole job.
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
// A failed git command's message can quote the remote URL, which carries the token.
const redact = (text) => (token ? String(text).replaceAll(token, "***") : String(text));

async function syncBranch(fork, work) {
  if (dryRun) return { status: "skipped (dry run)" };
  try {
    // Fast-forward only, the same way for forks and mirrors: fetch upstream's branch and ours, push without force.
    // (GitHub's merge-upstream would write a merge commit on a fork that has diverged; we never change the forks.)
    git(work, ["fetch", "--quiet", "--filter=blob:none", "--no-tags", "upstream", `+refs/heads/${fork.branch}:refs/remotes/upstream/${fork.branch}`]);
    // A mirror created empty has no branch yet: then the push creates it.
    const hasBranch = git(work, ["ls-remote", "--heads", "ours", fork.branch]).trim() !== "";
    if (hasBranch) git(work, ["fetch", "--quiet", "--filter=blob:none", "--no-tags", "ours", `+refs/heads/${fork.branch}:refs/remotes/ours/${fork.branch}`]);
    const before = hasBranch ? git(work, ["rev-parse", `refs/remotes/ours/${fork.branch}`]).trim() : null;
    const after = git(work, ["rev-parse", `refs/remotes/upstream/${fork.branch}`]).trim();
    if (before === after) return { status: "up to date" };
    // Decided from the commits, before pushing: only then is "not a fast-forward" what happened.
    if (before && spawnSync("git", ["merge-base", "--is-ancestor", before, after], { cwd: work }).status !== 0) {
      return { status: "not a fast-forward", problem: true, message: `${fork.repo} ${fork.branch} has commits upstream lacks, or upstream rewrote its history; nothing was pushed (forks/README.md › When the sync fails)` };
    }
    git(work, ["push", "--quiet", "ours", `refs/remotes/upstream/${fork.branch}:refs/heads/${fork.branch}`]);
    return { status: "fast-forwarded", from: before, to: after };
  } catch (error) {
    // git's own words, so the cause is visible: a refused push is usually the token or a branch rule.
    const text = redact(error.stderr || error.message).trim().split("\n").slice(-4).join(" ");
    const hint = /workflow/i.test(text) ? " FORK_SYNC_TOKEN needs Workflows: read and write." : "";
    return { status: "failed", problem: true, message: `${text}${hint}` };
  }
}

function pushTags(work, tags, report) {
  for (let i = 0; i < tags.length; i += BATCH) {
    const batch = tags.slice(i, i + BATCH);
    git(work, ["fetch", "--quiet", "--filter=blob:none", "--no-tags", "upstream", ...batch.map((tag) => `refs/tags/${tag}:refs/tags/${tag}`)]);
    // No force: a tag that appeared on ours since the plan is refused, never overwritten.
    git(work, ["push", "--quiet", "ours", ...batch.map((tag) => `refs/tags/${tag}:refs/tags/${tag}`)]);
    report.added += batch.length;
  }
}

async function syncOne(fork) {
  const report = { repo: fork.repo, upstream: fork.upstream, kind: fork.kind };
  if (fork.kind === "private-mirror" && !token) return { ...report, branch: { status: "skipped: a private mirror needs FORK_SYNC_TOKEN" }, tags: null };
  if (fork.kind === "private-mirror" && !dryRun) {
    // Code whose licence forbids redistribution: nothing is pushed unless the mirror is confirmed private.
    let meta;
    try {
      meta = await github("GET", `/repos/${fork.repo}`, token);
    } catch (error) {
      return { ...report, problem: true, branch: { status: "refused: could not confirm the mirror is private", message: redact(error.message) }, tags: null };
    }
    if (meta?.private !== true) return { ...report, problem: true, branch: { status: "refused: the mirror is public", message: `${fork.repo} is public. Make it private again; nothing was pushed.` }, tags: null };
  }
  const work = mkdtempSync(join(tmpdir(), "sync-forks-"));
  try {
    git(work, ["init", "--quiet", "--bare"]);
    git(work, ["remote", "add", "upstream", gitUrl(fork.upstream)]);
    git(work, ["remote", "add", "ours", gitUrl(fork.repo, token)]);
    report.branch = await syncBranch(fork, work);
    const plan = planTagSync(lsRemoteTags(gitUrl(fork.upstream)), lsRemoteTags(gitUrl(fork.repo, token)), fork.ignoreTags);
    const { open, push } = tagGate(plan, fork.acknowledgedTagChanges);
    report.tags = { toAdd: plan.add.length, moved: plan.moved, deletedUpstream: plan.deletedUpstream, unacknowledged: open, added: 0 };
    if (open.length > 0) {
      report.tags.stopped = `paused: upstream moved or deleted ${open.join(", ")}. Ours are kept; no tags were added. To accept, add ${JSON.stringify([...plan.moved.filter((m) => open.includes(m.tag)).map((m) => ({ tag: m.tag, upstream: m.upstream })), ...plan.deletedUpstream.filter((t) => open.includes(t)).map((tag) => ({ tag, upstream: null }))])} to acknowledgedTagChanges for ${fork.repo} in forks/forks.json, or a floating tag to ignoreTags (forks/README.md › When the sync fails).`;
    } else if (push.length > 0 && !dryRun) {
      pushTags(work, push, report.tags);
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
const summaryRow = (r) => `| ${r.repo} | ${r.branch?.status ?? "-"} | ${r.tags ? (dryRun ? r.tags.toAdd : r.tags.added) : "-"} | ${r.tags?.moved.map((m) => `${m.tag} (${m.ours.slice(0, 7)}→${m.upstream.slice(0, 7)})`).join(", ") || "-"} | ${r.tags?.deletedUpstream.join(", ") || "-"} | ${r.error ?? r.tags?.stopped ?? r.branch?.message ?? ""} |`;
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, [`## Fork sync${dryRun ? " (dry run)" : ""}`, "", "| Repository | Default branch | Tags added | Moved upstream (ours→theirs) | Deleted upstream | Note |", "|---|---|---|---|---|---|", ""].join("\n"));
const reports = [];
for (const fork of forks) {
  log(`${fork.repo} ← ${fork.upstream}`);
  const report = await syncOne(fork);
  log(`  branch: ${report.branch?.status ?? "-"}; tags: ${report.tags ? `${dryRun ? "would add" : "added"} ${dryRun ? report.tags.toAdd : report.tags.added}, moved ${report.tags.moved.length}, deleted upstream ${report.tags.deletedUpstream.length}` : "-"}${report.error ? `; error: ${report.error}` : ""}`);
  reports.push(report);
  // Row by row, so a job that times out still shows what it did.
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summaryRow(report)}\n`);
}

const failed = reports.filter((report) => report.problem);
const json = `${JSON.stringify({ dryRun, ok: failed.length === 0, reports })}\n`;
if (reportPath) writeFileSync(reportPath, json);
else process.stdout.write(json);
process.exitCode = failed.length === 0 ? 0 : 1;
