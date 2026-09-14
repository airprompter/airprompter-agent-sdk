/**
 * `airprompter import` and `airprompter login` (S11) against a fake registry:
 * the three habits map to the route's shape (a directory with front matter,
 * a CSV export, a SQL query's rows with a column map); the session token is
 * read from the environment and never argv; a re-run against the same fake
 * is idempotent (the fake derives ids the way the platform does); a dry run
 * writes nothing; a partial failure exits 4 and names the items; refusals
 * carry their reason.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { itemFromPromptFile, itemsFromCsv, itemsFromRows, parseColumnMap, parseCsv } from "../src/commands/importPrompts.js";
import { run } from "../src/cli.js";
import { EXIT, type Context } from "../src/io.js";

type Item = { key: string; title: string; content: string; categories?: string[]; platforms?: string[]; description?: string; tags?: string[] };

/** The route as the platform behaves: a derived id per (workspace, importKey, key); unchanged content is unchanged; a version per content. */
function fakeRegistry(options: { token?: string; failKeys?: string[]; missingCollection?: string } = {}) {
  const token = options.token ?? "session-token-1";
  const prompts = new Map<string, { content: string; versions: string[] }>();
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const derive = (workspaceId: string, importKey: string, key: string) => createHash("sha256").update(`${workspaceId}|${importKey}|${key}`).digest("hex").slice(0, 32);
  const fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const respond = (status: number, body: unknown) => ({ status, ok: status < 300, text: async () => JSON.stringify(body), json: async () => body, headers: new Headers() }) as unknown as Response;
    if (url.endsWith("/auth/sign-in")) {
      const body = JSON.parse(init?.body ?? "{}") as { email?: string; password?: string };
      if (body.email === "ada@example.com" && body.password === "correct horse") return respond(200, { accessToken: token, idToken: "id", expiresIn: 3600 });
      if (body.email === "mfa@example.com") return respond(200, { challengeName: "SOFTWARE_TOKEN_MFA" });
      return respond(401, { error: "Unauthorized", message: "Invalid email or password" });
    }
    const m = /\/team\/workspaces\/([^/]+)\/imports$/.exec(url);
    if (!m) return respond(404, { error: "Not Found" });
    if (init?.headers?.authorization !== `Bearer ${token}`) return respond(401, { error: "Unauthorized" });
    const body = JSON.parse(init?.body ?? "{}") as { importKey: string; collectionId: string; dryRun?: boolean; items: Item[]; defaults?: { categories?: string[]; platforms?: string[] } };
    requests.push({ url, body });
    if (body.collectionId === options.missingCollection) return respond(404, { error: "Collection not found" });
    const workspaceId = decodeURIComponent(m[1]!);
    const summary = { create: 0, update: 0, unchanged: 0, created: 0, updated: 0, failed: 0 };
    const items = body.items.map((item) => {
      const promptId = derive(workspaceId, body.importKey, item.key);
      const existing = prompts.get(promptId);
      if (!(item.categories?.length || body.defaults?.categories?.length)) throw new Error("the fake was sent an item without categories: the CLI must refuse first");
      if (options.failKeys?.includes(item.key) && !body.dryRun) {
        summary.failed += 1;
        return { key: item.key, promptId, status: "failed", reason: "snapshot_409:stale" };
      }
      const unchanged = existing !== undefined && existing.content === item.content;
      if (body.dryRun) {
        const status = existing ? (unchanged ? "unchanged" : "update") : "create";
        summary[status] += 1;
        return { key: item.key, promptId, status };
      }
      if (!existing) {
        prompts.set(promptId, { content: item.content, versions: ["rev-1"] });
        summary.created += 1;
        return { key: item.key, promptId, status: "created", versionId: "rev-1", reviewSubmitted: true };
      }
      if (unchanged) {
        summary.unchanged += 1;
        return { key: item.key, promptId, status: "unchanged", versionId: existing.versions.at(-1), reviewSubmitted: true };
      }
      const versionId = `rev-${existing.versions.length + 1}`;
      existing.content = item.content;
      existing.versions.push(versionId);
      summary.updated += 1;
      return { key: item.key, promptId, status: "updated", versionId, reviewSubmitted: true };
    });
    return respond(200, { importKey: body.importKey, workspaceId, dryRun: body.dryRun === true, summary, items });
  };
  return { fetch, prompts, requests, token };
}

function harness(registry: ReturnType<typeof fakeRegistry> | null, env: Record<string, string> = {}) {
  const work = mkdtempSync(join(tmpdir(), "ap-import-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx: Context = { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l), env: { HOME: work, ...env }, cwd: work, now: () => Date.now(), fetch: registry ? (registry.fetch as never) : null, isTTY: false };
  return { work, stdout, stderr, ctx, cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

function promptDirectory(root: string): string {
  const dir = join(root, "prompts");
  mkdirSync(join(dir, "support"), { recursive: true });
  mkdirSync(join(dir, "sales"), { recursive: true });
  writeFileSync(join(dir, "support", "triage.md"), "---\ndescription: Triage a ticket\ncategories: support, ops\nplatforms: claude\ntags: tier-1\n---\n# Ticket triage\n\nTriage {{ticket}} for {{team}}.\n");
  writeFileSync(join(dir, "support", "reply.md"), "# Reply\n\nReply to {{name}}.\n");
  writeFileSync(join(dir, "sales", "pitch.txt"), "Pitch {{product}} to {{buyer}}.");
  writeFileSync(join(dir, "README.md"), "# Not a prompt? It still is one — every .md file is; keep notes elsewhere.\n");
  writeFileSync(join(dir, ".hidden.md"), "ignored");
  writeFileSync(join(dir, "image.png"), "ignored");
  return dir;
}

test("the three habits map to the route's shape: a directory with front matter, a CSV export, query rows with a column map", () => {
  const md = itemFromPromptFile("support/triage.md", "---\ndescription: Triage a ticket\ncategories: support, ops\nplatforms: claude\n---\n# Ticket triage\n\nTriage {{ticket}}.\n");
  assert.deepEqual(md, { key: "support/triage.md", title: "Ticket triage", content: "# Ticket triage\n\nTriage {{ticket}}.", description: "Triage a ticket", categories: ["support", "ops"], platforms: ["claude"] });
  assert.equal(itemFromPromptFile("sales/pitch.txt", "Pitch it.").title, "pitch", "no heading: the file name");
  assert.deepEqual(parseCsv('key,title,content\na,"A, the first","Line one\nline ""two"""\nb,B,plain\n'), [["key", "title", "content"], ["a", "A, the first", 'Line one\nline "two"'], ["b", "B", "plain"]]);
  const csv = itemsFromCsv("key,title,content,categories,platforms\nsupport/triage,Triage,Triage {{t}},support,claude\n");
  assert.deepEqual(csv, [{ key: "support/triage", title: "Triage", content: "Triage {{t}}", categories: ["support"], platforms: ["claude"] }]);
  const rows = itemsFromRows([{ slug: "triage", name: "Triage", body: "Triage {{t}}", cats: "support" }, { slug: "reply", name: null, body: "Reply" }], parseColumnMap("key=slug,title=name,content=body,categories=cats"));
  assert.deepEqual(rows, [{ key: "triage", title: "Triage", content: "Triage {{t}}", categories: ["support"] }, { key: "reply", title: "reply", content: "Reply" }]);
  assert.throws(() => parseColumnMap("key=slug,title=name"), /content=<column>/);
  assert.throws(() => itemsFromRows([{ slug: "", body: "x" }], parseColumnMap("key=slug,title=slug,content=body")), /no value in the "slug" column/);
});

test("a directory of prompts becomes reviewable versions; a re-run is idempotent; a change is a new version; a dry run writes nothing; the token comes from the environment", async () => {
  const registry = fakeRegistry();
  const h = harness(registry, { AIRPROMPTER_SESSION_TOKEN: registry.token });
  try {
    const dir = promptDirectory(h.work);
    const args = ["import", "--workspace", "ws-1", "--collection", "col-1", "--from", dir, "--key", "git:prompts", "--category", "general", "--platform", "claude", "--base-url", "https://api.test", "--json"];
    assert.equal(await run(args, h.ctx), EXIT.ok, h.stderr.join("\n"));
    const first = JSON.parse(h.stdout.at(-1)!) as { items: Array<{ key: string; status: string; versionId?: string }>; summary: Record<string, number> };
    assert.deepEqual(first.items.map((i) => [i.key, i.status]), [["README.md", "created"], ["sales/pitch.txt", "created"], ["support/reply.md", "created"], ["support/triage.md", "created"]], "every prompt file, by its relative path, in a stable order; dotfiles and other files skipped");
    assert.equal(first.summary.created, 4);
    const sent = registry.requests[0]!.body as { defaults: { categories: string[]; platforms: string[] }; items: Item[] };
    assert.deepEqual(sent.defaults, { categories: ["general"], platforms: ["claude"] });
    const triage = sent.items.find((i) => i.key === "support/triage.md")!;
    assert.deepEqual({ categories: triage.categories, platforms: triage.platforms, tags: triage.tags, description: triage.description, title: triage.title }, { categories: ["support", "ops"], platforms: ["claude"], tags: ["tier-1"], description: "Triage a ticket", title: "Ticket triage" }, "front matter wins over defaults");

    h.stdout.length = 0;
    assert.equal(await run(args, h.ctx), EXIT.ok);
    const second = JSON.parse(h.stdout.at(-1)!) as { items: Array<{ status: string }>; summary: Record<string, number> };
    assert.equal(second.summary.unchanged, 4, "nothing changed, nothing written");
    assert.equal(registry.prompts.size, 4);

    writeFileSync(join(dir, "support", "reply.md"), "# Reply\n\nReply to {{name}} warmly.\n");
    h.stdout.length = 0;
    assert.equal(await run([...args, "--dry-run"], h.ctx), EXIT.ok);
    const dry = JSON.parse(h.stdout.at(-1)!) as { dryRun: boolean; items: Array<{ key: string; status: string }> };
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.items.filter((i) => i.status !== "unchanged").map((i) => [i.key, i.status]), [["support/reply.md", "update"]]);
    assert.equal(registry.prompts.size, 4, "a dry run wrote nothing");
    h.stdout.length = 0;
    assert.equal(await run(args, h.ctx), EXIT.ok);
    const third = JSON.parse(h.stdout.at(-1)!) as { items: Array<{ key: string; promptId: string; status: string; versionId?: string }>; summary: Record<string, number> };
    assert.deepEqual(third.items.find((i) => i.key === "support/reply.md"), { key: "support/reply.md", promptId: third.items.find((i) => i.key === "support/reply.md")!.promptId, status: "updated", versionId: "rev-2", reviewSubmitted: true } as never);
    assert.equal(third.summary.updated, 1);
  } finally {
    h.cleanup();
  }
});

test("the token is never on argv; without it the command refuses before any request; a stale token is a refusal with its reason", async () => {
  const registry = fakeRegistry();
  const h = harness(registry);
  try {
    const dir = promptDirectory(h.work);
    const base = ["import", "--workspace", "ws-1", "--collection", "col-1", "--from", dir, "--key", "k", "--category", "c", "--platform", "claude", "--base-url", "https://api.test"];
    assert.equal(await run(base, h.ctx), EXIT.usage);
    assert.match(h.stderr.join("\n"), /AIRPROMPTER_SESSION_TOKEN is not set/);
    assert.equal(registry.requests.length, 0, "nothing was sent");
    assert.equal(await run(["import", "--session-token", "x"], h.ctx), EXIT.usage, "there is no --session-token flag");
    h.ctx.env.AIRPROMPTER_SESSION_TOKEN = "expired";
    h.stderr.length = 0;
    assert.equal(await run(base, h.ctx), EXIT.refused);
    assert.match(h.stderr.join("\n"), /session token was not accepted/);
  } finally {
    h.cleanup();
  }
});

test("items without categories or services and no default are refused before any request; a missing collection is a refusal; a partial failure exits 4 and names the items", async () => {
  const registry = fakeRegistry({ failKeys: ["b"], missingCollection: "col-nope" });
  const h = harness(registry, { AIRPROMPTER_SESSION_TOKEN: registry.token });
  try {
    const rows = join(h.work, "rows.json");
    writeFileSync(rows, JSON.stringify([{ slug: "a", name: "A", body: "A" }, { slug: "b", name: "B", body: "B" }]));
    const base = ["import", "--workspace", "ws-1", "--collection", "col-1", "--from", rows, "--map", "key=slug,title=name,content=body", "--key", "postgres:prompts", "--base-url", "https://api.test"];
    assert.equal(await run(base, h.ctx), EXIT.usage);
    assert.match(h.stderr.join("\n"), /name no categories or AI services/);
    assert.equal(registry.requests.length, 0);
    h.stderr.length = 0;
    assert.equal(await run([...base.map((a) => (a === "col-1" ? "col-nope" : a)), "--category", "c", "--platform", "claude"], h.ctx), EXIT.refused);
    assert.match(h.stderr.join("\n"), /workspace or collection was not found/);
    h.stderr.length = 0;
    h.stdout.length = 0;
    assert.equal(await run([...base, "--category", "c", "--platform", "claude", "--json"], h.ctx), EXIT.partial);
    const doc = JSON.parse(h.stdout.at(-1)!) as { items: Array<{ key: string; status: string; reason?: string }>; summary: Record<string, number> };
    assert.deepEqual(doc.items.map((i) => [i.key, i.status, i.reason ?? null]), [["a", "created", null], ["b", "failed", "snapshot_409:stale"]]);
    assert.match(h.stderr.join("\n"), /1 item\(s\) failed; the others landed/);
  } finally {
    h.cleanup();
  }
});

test("login: the password comes from the environment or a terminal, never argv; a challenge and a bad password are refusals; the token is printed as an export line or JSON", async () => {
  const registry = fakeRegistry({ token: "tok-abc" });
  const h = harness(registry, { AIRPROMPTER_PASSWORD: "correct horse" });
  try {
    assert.equal(await run(["login", "--email", "Ada@Example.com", "--base-url", "https://api.test"], h.ctx), EXIT.ok, h.stderr.join("\n"));
    assert.ok(h.stdout.some((l) => l === "export AIRPROMPTER_SESSION_TOKEN=tok-abc"), h.stdout.join("\n"));
    h.stdout.length = 0;
    assert.equal(await run(["login", "--email", "ada@example.com", "--base-url", "https://api.test", "--json"], h.ctx), EXIT.ok);
    assert.deepEqual(JSON.parse(h.stdout.at(-1)!), { accessToken: "tok-abc", expiresIn: 3600 });
    assert.equal(await run(["login", "--email", "ada@example.com", "--password", "x"], h.ctx), EXIT.usage, "there is no --password flag");
    h.ctx.env.AIRPROMPTER_PASSWORD = "wrong";
    h.stderr.length = 0;
    assert.equal(await run(["login", "--email", "ada@example.com", "--base-url", "https://api.test"], h.ctx), EXIT.refused);
    assert.match(h.stderr.join("\n"), /invalid email or password/);
    h.ctx.env.AIRPROMPTER_PASSWORD = "correct horse";
    h.stderr.length = 0;
    assert.equal(await run(["login", "--email", "mfa@example.com", "--base-url", "https://api.test"], h.ctx), EXIT.refused);
    assert.match(h.stderr.join("\n"), /another step \(SOFTWARE_TOKEN_MFA\)/);
    delete h.ctx.env.AIRPROMPTER_PASSWORD;
    h.stderr.length = 0;
    assert.equal(await run(["login", "--email", "ada@example.com", "--base-url", "https://api.test"], h.ctx), EXIT.usage, "no terminal, no env: refused without a request");
    assert.match(h.stderr.join("\n"), /never taken on argv/);
  } finally {
    h.cleanup();
  }
});
