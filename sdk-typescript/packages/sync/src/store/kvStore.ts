/**
 * The storage primitive under the release datastore (T40): a key-value store
 * with four operations every backend already has — `get` (the value and an
 * opaque version), a CONDITIONAL `put` (`ifAbsent`, or `ifVersion` — the
 * version last read), `list` by prefix, and `delete`. No transaction is ever
 * asked for: `kvReleaseDatastore` orders its writes instead
 * (`protocol/datastore-format.md`). An adapter for S3, GCS, DynamoDB, Redis,
 * etcd or a SQL table is a few dozen lines; `@airprompter/datastore-s3`,
 * `-postgres` and `-redis` ship three. `checkKvStore` is the suite an
 * adapter runs against a live backend to show it keeps the contract.
 *
 * @example
 * ```ts
 * const kv: KvStore = new MemoryKvStore(); // or fsKvStore(dir), or an adapter over your backend
 * await kv.put("a/b.json", "{}", { ifAbsent: true });   // true: written; false: it was already there
 * const entry = await kv.get("a/b.json");                 // { value, version }
 * await kv.put("a/b.json", "[]", { ifVersion: entry!.version }); // false when someone wrote in between
 * const report = await checkKvStore(kv);                  // { ok, failures, passed } — an adapter's own test
 * ```
 */

import { createHash, randomBytes } from "node:crypto";
import { join, sep } from "node:path";
import { nodeFs, type FsPort } from "@airprompter/agent-core";

export interface KvEntry {
  value: string;
  /** Opaque: whatever the backend compares for `ifVersion` (an ETag, a row version, a content hash). */
  version: string;
}

export type KvPutCondition = { ifAbsent: true } | { ifVersion: string };

export interface KvStore {
  get(key: string): Promise<KvEntry | null>;
  /** Write only when the condition holds; `false` (never a throw) when it does not — someone else wrote first. */
  put(key: string, value: string, condition: KvPutCondition): Promise<boolean>;
  /** Every key starting with `prefix`, exactly (no wildcard in it means anything), in any order. */
  list(prefix: string): Promise<string[]>;
  /** Removes the key; a key that is not there is not an error. */
  delete(key: string): Promise<void>;
}

/** A `KvStore` in memory: tests and dev loops. Versions are a counter. */
export class MemoryKvStore implements KvStore {
  private readonly entries = new Map<string, KvEntry>();
  private counter = 0;

  async get(key: string): Promise<KvEntry | null> {
    const entry = this.entries.get(key);
    return entry ? { ...entry } : null;
  }

  async put(key: string, value: string, condition: KvPutCondition): Promise<boolean> {
    const current = this.entries.get(key);
    if ("ifAbsent" in condition ? current !== undefined : current?.version !== condition.ifVersion) return false;
    this.counter += 1;
    this.entries.set(key, { value, version: String(this.counter) });
    return true;
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.entries.keys()].filter((key) => key.startsWith(prefix));
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

const versionOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * A `KvStore` over a directory (through the filesystem port): a key is a relative path under it, the version is the
 * content's SHA-256. Writes go to a temp file and are renamed into place, so a reader never sees half a value. The
 * check-then-write is atomic within one process only: give a directory ONE writer (the puller) — any number of
 * runtimes may read it, over a shared volume too. For several writers, use a backend with native conditional writes.
 */
export function fsKvStore(dir: string, fs: FsPort = nodeFs): KvStore {
  const pathOf = (key: string): string => {
    const parts = key.split("/");
    if (key.length === 0 || key.startsWith("/") || parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\\"))) throw new Error(`not a relative key: ${JSON.stringify(key)}`);
    return join(dir, ...parts);
  };
  return {
    async get(key) {
      const path = pathOf(key);
      if (!fs.exists(path)) return null;
      const bytes = fs.readFile(path);
      return { value: new TextDecoder().decode(bytes), version: versionOf(bytes) };
    },
    async put(key, value, condition) {
      const path = pathOf(key);
      const exists = fs.exists(path);
      if ("ifAbsent" in condition ? exists : !exists || versionOf(fs.readFile(path)) !== condition.ifVersion) return false;
      fs.mkdirp(join(path, ".."), 0o700);
      const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
      fs.writeFile(temp, new TextEncoder().encode(value), 0o600);
      fs.rename(temp, path);
      return true;
    },
    async list(prefix) {
      // The deepest directory the prefix names, then an exact prefix match on the relative paths under it.
      const slash = prefix.lastIndexOf("/");
      const dirPart = slash === -1 ? "" : prefix.slice(0, slash + 1);
      const root = dirPart ? join(dir, ...dirPart.split("/").filter(Boolean)) : dir;
      return fs
        .listRecursive(root)
        .map((relative) => dirPart + relative.split(sep).join("/"))
        .filter((key) => key.startsWith(prefix) && !key.endsWith(".tmp"));
    },
    async delete(key) {
      const path = pathOf(key);
      if (fs.exists(path)) fs.unlink(path);
    },
  };
}

export interface KvStoreReport {
  ok: boolean;
  passed: string[];
  failures: string[];
}

/**
 * The contract every `KvStore` must keep, run against a live backend: conditional writes (absent, version, stale
 * version, absent key), exact prefix listing (no `%`, `_`, `*`, `?` or `[` is a wildcard), round trips of non-ASCII
 * and large values, deletes, and — the part a hand-rolled adapter gets wrong — racing writers: of N concurrent
 * `ifAbsent` puts, or N puts on one version, exactly one wins. Writes only under `prefix` (a random sub-prefix of it)
 * and removes what it wrote.
 */
export async function checkKvStore(kv: KvStore, options: { prefix?: string; largeValueBytes?: number; racers?: number; /** `false` for a store over a Windows filesystem, which cannot name a file `*`, `?` or `[`. */ globCharacters?: boolean } = {}): Promise<KvStoreReport> {
  const root = `${options.prefix ?? "airprompter-kv-check/"}${randomBytes(6).toString("hex")}/`;
  const passed: string[] = [];
  const failures: string[] = [];
  const written = new Set<string>();
  const check = async (name: string, body: () => Promise<boolean | string>) => {
    try {
      const result = await body();
      if (result === true) passed.push(name);
      else failures.push(`${name}${typeof result === "string" ? `: ${result}` : ""}`);
    } catch (error) {
      failures.push(`${name}: threw ${(error as Error).message}`);
    }
  };
  const put = async (key: string, value: string, condition: KvPutCondition) => {
    written.add(key);
    return kv.put(key, value, condition);
  };

  const a = `${root}a.json`;
  let first: KvEntry | null = null;
  await check("get of a missing key is null", async () => (await kv.get(a)) === null);
  await check("ifAbsent writes a missing key", async () => (await put(a, "one", { ifAbsent: true })) === true);
  await check("get returns the value and a version", async () => {
    first = await kv.get(a);
    return first?.value === "one" && typeof first.version === "string" && first.version.length > 0 ? true : JSON.stringify(first);
  });
  await check("ifAbsent refuses a present key and leaves it", async () => (await put(a, "two", { ifAbsent: true })) === false && (await kv.get(a))?.value === "one");
  let second: KvEntry | null = null;
  await check("ifVersion writes on the version read, and the version changes", async () => {
    const wrote = await put(a, "three", { ifVersion: first!.version });
    second = await kv.get(a);
    return wrote && second?.value === "three" && second.version !== first!.version ? true : JSON.stringify(second);
  });
  await check("ifVersion refuses a stale version and leaves the value", async () => (await put(a, "four", { ifVersion: first!.version })) === false && (await kv.get(a))?.value === "three");
  await check("ifVersion refuses a missing key", async () => (await put(`${root}missing.json`, "x", { ifVersion: second?.version ?? "1" })) === false && (await kv.get(`${root}missing.json`)) === null);

  const specials = options.globCharacters === false ? ["a%b"] : ["a%b", "a*b", "a?b", "a[b]"];
  const listed = [`${root}l/a_b/1.json`, `${root}l/a_b/2.json`, `${root}l/aXb/1.json`, ...specials.map((special) => `${root}l/${special}/1.json`), `${root}l/a_b-other.json`];
  for (const key of listed) await put(key, "{}", { ifAbsent: true });
  await check("list returns exactly the keys under a prefix", async () => {
    const got = (await kv.list(`${root}l/a_b/`)).sort();
    return JSON.stringify(got) === JSON.stringify([`${root}l/a_b/1.json`, `${root}l/a_b/2.json`]) ? true : JSON.stringify(got);
  });
  await check("no character in a prefix is a wildcard", async () => {
    for (const special of specials) {
      const got = await kv.list(`${root}l/${special}/`);
      if (got.length !== 1 || got[0] !== `${root}l/${special}/1.json`) return `${special}: ${JSON.stringify(got)}`;
    }
    return true;
  });
  await check("list of an empty prefix is empty", async () => (await kv.list(`${root}nothing/`)).length === 0);

  await check("non-ASCII values round-trip", async () => {
    const value = JSON.stringify({ text: "zürich — 東京 — 🚀", nul: "a\u0000b" });
    await put(`${root}utf8.json`, value, { ifAbsent: true });
    return (await kv.get(`${root}utf8.json`))?.value === value;
  });
  await check("large values round-trip", async () => {
    const value = "x".repeat(options.largeValueBytes ?? 512 * 1024);
    await put(`${root}large.json`, value, { ifAbsent: true });
    return (await kv.get(`${root}large.json`))?.value === value;
  });

  const racers = options.racers ?? 8;
  await check(`of ${racers} racing ifAbsent writes exactly one wins`, async () => {
    const key = `${root}race-absent.json`;
    written.add(key);
    const results = await Promise.all(Array.from({ length: racers }, (_, i) => kv.put(key, `racer-${i}`, { ifAbsent: true })));
    const winners = results.filter(Boolean).length;
    const value = (await kv.get(key))?.value;
    return winners === 1 && value === `racer-${results.indexOf(true)}` ? true : `${winners} winners, value ${value}`;
  });
  await check(`of ${racers} racing writes on one version exactly one wins`, async () => {
    const key = `${root}race-version.json`;
    await put(key, "base", { ifAbsent: true });
    const base = (await kv.get(key))!;
    const results = await Promise.all(Array.from({ length: racers }, (_, i) => kv.put(key, `racer-${i}`, { ifVersion: base.version })));
    const winners = results.filter(Boolean).length;
    const value = (await kv.get(key))?.value;
    return winners === 1 && value === `racer-${results.indexOf(true)}` ? true : `${winners} winners, value ${value}`;
  });

  await check("delete removes a key; deleting a missing key is not an error", async () => {
    await kv.delete(a);
    await kv.delete(`${root}never-written.json`);
    return (await kv.get(a)) === null && !(await kv.list(root)).includes(a);
  });
  await check("a deleted key can be written with ifAbsent again", async () => (await put(a, "again", { ifAbsent: true })) === true);

  for (const key of written) await kv.delete(key).catch(() => undefined);
  await check("everything written is gone", async () => {
    const left = await kv.list(root);
    return left.length === 0 ? true : JSON.stringify(left);
  });
  return { ok: failures.length === 0, passed, failures };
}
