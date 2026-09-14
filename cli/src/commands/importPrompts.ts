/**
 * `airprompter import` (S11): a customer's prompts — a directory, a JSON or
 * CSV export, a SQL query result — become workspace prompts with reviewable
 * versions in AirPrompter, idempotently. The CLI maps the source into the
 * import route's request and posts it; the platform derives every prompt's
 * id from (workspace, import key, item key), so a re-run finds what it made:
 * unchanged content is reported and nothing is written, changed content is
 * a new version, a new key is a new prompt.
 *
 * Sources, and what becomes the item key:
 *   --from <dir>          every .md / .txt / .prompt file; key = the path relative to the directory, title = the first
 *                         `# heading` or the file name; an optional front-matter block (`---` … `---`) with
 *                         description:, categories:, platforms:, tags: (comma-separated) fills the rest
 *   --from <file.json>    an array of items, or {items:[…]}, already in the route's shape (key, title, content, …)
 *   --from <file.csv>     a header row naming key, title, content (and any of description, categories, platforms, tags)
 *   --from <rows.json> --map key=slug,title=name,content=body
 *                         a SQL query's rows (psql --json, mysql --json, any JSON array of objects) with the columns mapped
 *
 * Authentication: team writes need a signed-in user, never an API key
 * (AIR-1854). `airprompter login` prints the session token; this command
 * reads it from the environment (`--session-token-env`, default
 * AIRPROMPTER_SESSION_TOKEN) and never from argv.
 *
 * Exit status: 0 when every item landed (or, on --dry-run, when the plan was
 * printed); 1 (refused) when the route refused the request; 4 when one or more
 * items failed — the others still landed, and the output names each.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { EXIT, Output, refused, requireOption, usage, type Context } from "../io.js";
import { COMMON_OPTIONS, flag, helpFor, parse, str, type OptionSpec } from "../args.js";
import { CLI_VERSION } from "../version.js";

export const IMPORT_OPTIONS: OptionSpec = {
  workspace: { type: "string", help: "The workspace id the prompts belong to (the URL of the workspace's board carries it)" },
  collection: { type: "string", help: "The workspace collection the prompts are placed in" },
  from: { type: "string", help: "A directory of prompt files, a JSON or CSV export, or a JSON file of query rows" },
  key: { type: "string", help: "The import key: names the SOURCE (e.g. git:prompts, postgres:prompts); the same key on every run is what makes re-runs idempotent" },
  map: { type: "string", help: "Column mapping for query rows: key=<col>,title=<col>,content=<col>[,description=<col>,categories=<col>,platforms=<col>,tags=<col>]" },
  category: { type: "string", multiple: true, help: "Default category for items that name none (repeatable)" },
  platform: { type: "string", multiple: true, help: "Default AI service for items that name none (repeatable), e.g. claude, chatgpt" },
  tag: { type: "string", multiple: true, help: "Default tag for items that name none (repeatable)" },
  "dry-run": { type: "boolean", help: "Print the plan (create / update / unchanged per item); write nothing" },
  "base-url": { type: "string", help: "AirPrompter API base URL (default https://api.airprompter.com)" },
  "session-token-env": { type: "string", default: "AIRPROMPTER_SESSION_TOKEN", help: "Environment variable holding the session token from `airprompter login` (never passed on argv)" },
  ...COMMON_OPTIONS,
};

export interface ImportItem {
  key: string;
  title: string;
  content: string;
  description?: string;
  categories?: string[];
  platforms?: string[];
  tags?: string[];
}

const PROMPT_FILE = /\.(md|txt|prompt)$/i;

function splitList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

/** A prompt file: optional front matter, then the text; the first `# heading` names it. */
export function itemFromPromptFile(key: string, raw: string): ImportItem {
  let text = raw.replace(/\r\n/g, "\n");
  const meta: Record<string, string> = {};
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (front) {
    for (const line of front[1]!.split("\n")) {
      const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (m) meta[m[1]!.toLowerCase()] = m[2]!.trim();
    }
    text = text.slice(front[0].length);
  }
  const heading = /^#\s+(.+?)\s*$/m.exec(text);
  const title = meta.title ?? heading?.[1] ?? key.replace(/\.[^.]+$/, "").split("/").pop() ?? key;
  const item: ImportItem = { key, title, content: text.trim() };
  if (meta.description) item.description = meta.description;
  const categories = splitList(meta.categories ?? meta.category);
  const platforms = splitList(meta.platforms ?? meta.platform ?? meta.services);
  const tags = splitList(meta.tags);
  if (categories?.length) item.categories = categories;
  if (platforms?.length) item.platforms = platforms;
  if (tags?.length) item.tags = tags;
  return item;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (PROMPT_FILE.test(entry)) out.push(path);
  }
  return out;
}

export function itemsFromDirectory(dir: string): ImportItem[] {
  return walk(dir).map((path) => itemFromPromptFile(relative(dir, path).split(sep).join("/"), readFileSync(path, "utf8")));
}

/** RFC 4180 enough: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/\r\n/g, "\n");
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim().length));
}

export function itemsFromCsv(text: string): ImportItem[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw usage("the CSV has no header row");
  const columns = header.map((h) => h.trim().toLowerCase());
  const objects = rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ""])));
  return itemsFromRows(objects, { key: "key", title: "title", content: "content", description: "description", categories: "categories", platforms: "platforms", tags: "tags" });
}

export type ColumnMap = { key: string; title: string; content: string; description?: string; categories?: string; platforms?: string; tags?: string };

export function parseColumnMap(spec: string): ColumnMap {
  const map: Record<string, string> = {};
  for (const pair of spec.split(",")) {
    const [field, column] = pair.split("=").map((s) => s.trim());
    if (!field || !column) throw usage(`--map: "${pair}" is not field=column`);
    map[field] = column;
  }
  for (const required of ["key", "title", "content"]) if (!map[required]) throw usage(`--map must name ${required}=<column>`);
  return map as unknown as ColumnMap;
}

/** Query rows (or CSV objects) into items through a column map. */
export function itemsFromRows(rows: Array<Record<string, unknown>>, map: ColumnMap): ImportItem[] {
  return rows.map((row, index) => {
    const key = row[map.key];
    const title = row[map.title];
    const content = row[map.content];
    if (key === undefined || key === null || String(key).trim() === "") throw usage(`row ${index + 1}: no value in the "${map.key}" column`);
    if (content === undefined || content === null || String(content).trim() === "") throw usage(`row ${index + 1}: no value in the "${map.content}" column`);
    const item: ImportItem = { key: String(key).trim(), title: String(title ?? key).trim(), content: String(content) };
    if (map.description && row[map.description]) item.description = String(row[map.description]).trim();
    const categories = map.categories ? splitList(row[map.categories]) : undefined;
    const platforms = map.platforms ? splitList(row[map.platforms]) : undefined;
    const tags = map.tags ? splitList(row[map.tags]) : undefined;
    if (categories?.length) item.categories = categories;
    if (platforms?.length) item.platforms = platforms;
    if (tags?.length) item.tags = tags;
    return item;
  });
}

/** Whatever `--from` names, as items. */
export function itemsFromSource(from: string, map: string | undefined): ImportItem[] {
  if (!existsSync(from)) throw usage(`--from: ${from} does not exist`);
  if (statSync(from).isDirectory()) {
    if (map) throw usage("--map applies to query rows, not a directory");
    return itemsFromDirectory(from);
  }
  const text = readFileSync(from, "utf8");
  if (/\.csv$/i.test(from)) return itemsFromCsv(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usage(`--from: ${from} is neither a directory, a .csv, nor JSON`);
  }
  const rows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items : Array.isArray((parsed as { rows?: unknown }).rows) ? (parsed as { rows: unknown[] }).rows : null;
  if (!rows) throw usage("--from: the JSON must be an array of items or rows, or {items:[…]} / {rows:[…]}");
  if (map) return itemsFromRows(rows as Array<Record<string, unknown>>, parseColumnMap(map));
  return itemsFromRows(rows as Array<Record<string, unknown>>, { key: "key", title: "title", content: "content", description: "description", categories: "categories", platforms: "platforms", tags: "tags" });
}

export interface ImportResponse {
  importKey: string;
  workspaceId: string;
  dryRun: boolean;
  summary: { create: number; update: number; unchanged: number; created: number; updated: number; failed: number };
  items: Array<{ key: string; promptId: string; status: string; versionId?: string; reviewSubmitted?: boolean; reason?: string }>;
}

export async function importPrompts(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, IMPORT_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("import", "--workspace … --collection … --from <dir|file> --key <source> [--map …] [--dry-run]", IMPORT_OPTIONS));
    return EXIT.ok;
  }
  const out = new Output(ctx, flag(parsed, "json"));
  const workspaceId = requireOption(str(parsed, "workspace"), "workspace");
  const collectionId = requireOption(str(parsed, "collection"), "collection");
  const from = requireOption(str(parsed, "from"), "from");
  const importKey = requireOption(str(parsed, "key"), "key");
  const tokenEnv = str(parsed, "session-token-env") ?? "AIRPROMPTER_SESSION_TOKEN";
  const token = ctx.env[tokenEnv];
  if (!token) throw usage(`${tokenEnv} is not set — run \`airprompter login\` and export the token it prints (a signed-in user, never an API key: team writes need one)`);
  if (!ctx.fetch) throw usage("no fetch available: Node 20+ is required");

  const items = itemsFromSource(from, str(parsed, "map"));
  if (items.length === 0) throw usage(`${from}: nothing to import`);
  const defaults: Record<string, string[]> = {};
  const categories = (parsed.values.category as string[] | undefined) ?? [];
  const platforms = (parsed.values.platform as string[] | undefined) ?? [];
  const tags = (parsed.values.tag as string[] | undefined) ?? [];
  if (categories.length) defaults.categories = categories;
  if (platforms.length) defaults.platforms = platforms;
  if (tags.length) defaults.tags = tags;
  const missing = items.filter((item) => !(item.categories?.length || defaults.categories) || !(item.platforms?.length || defaults.platforms));
  if (missing.length) throw usage(`${missing.length} item(s) name no categories or AI services and no default was given (--category, --platform); first: ${missing[0]!.key}`);

  const body = { importKey, collectionId, ...(Object.keys(defaults).length ? { defaults } : {}), ...(flag(parsed, "dry-run") ? { dryRun: true } : {}), items };
  const baseUrl = (str(parsed, "base-url") ?? "https://api.airprompter.com").replace(/\/+$/, "");
  const response = await ctx.fetch(`${baseUrl}/team/workspaces/${encodeURIComponent(workspaceId)}/imports`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": `airprompter-cli/${CLI_VERSION}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status === 401) throw refused("the session token was not accepted; run `airprompter login` again", { reason: "unauthorized" });
  if (response.status === 403) throw refused("you do not have permission to import into this workspace", { reason: "forbidden" });
  if (response.status === 404) throw refused("the workspace or collection was not found (or this AirPrompter does not offer imports yet)", { reason: "not_found" });
  if (response.status !== 200) {
    let message = `HTTP ${response.status}`;
    try {
      const parsedBody = JSON.parse(text) as { error?: string; message?: string };
      message = parsedBody.message ?? parsedBody.error ?? message;
    } catch {
      // the status is the message
    }
    throw refused(`the import was refused: ${message}`, { reason: `http_${response.status}` });
  }
  const result = JSON.parse(text) as ImportResponse;
  out.field("workspace", result.workspaceId);
  out.field("importKey", result.importKey, "import key");
  out.field("dryRun", result.dryRun, "dry run");
  for (const item of result.items) {
    out.line(`  ${item.status.padEnd(10)} ${item.key}${item.versionId ? ` → ${item.versionId}` : ""}${item.reviewSubmitted === false ? " (not yet on the board; re-run submits it)" : ""}${item.reason ? ` (${item.reason})` : ""}`);
  }
  out.set("items", result.items);
  const s = result.summary;
  out.field("summary", result.dryRun ? `${s.create} to create, ${s.update} to update, ${s.unchanged} unchanged` : `${s.created} created, ${s.updated} updated, ${s.unchanged} unchanged, ${s.failed} failed`);
  if (!result.dryRun && (s.created > 0 || s.updated > 0)) out.line("Each new version is submitted for review; approve it on the workspace board, then set it up on an agent and release it.");
  out.flush({ summary: s, ...(s.failed > 0 ? { ok: false, failed: result.items.filter((i) => i.status === "failed").map((i) => i.key) } : {}) });
  if (s.failed > 0) {
    // The document above is the result — every item and its reason — so this is a status, not an error document.
    ctx.stderr(`partial: ${s.failed} item(s) failed; the others landed (see each item's reason)`);
    return EXIT.partial;
  }
  return EXIT.ok;
}
