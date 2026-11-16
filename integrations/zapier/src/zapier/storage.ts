/**
 * The signed release kept on the Zapier side: a `KvStore` over `z.cache`, under the SDK's shared datastore format
 * (`kvReleaseDatastore`), so steps keep serving while AirPrompter is unreachable. Why `z.cache` and its limits are
 * in this package's README ("Where the signed copy lives").
 *
 * - **Scope.** Every key is written with scope `["auth"]`: one copy per Zapier connection (one agent, one
 *   environment, one Update key), shared by every Zap and step that uses the connection, invisible to others. Keys
 *   also carry a label derived from the connection, so a copy written under another key never collides.
 * - **What is stored.** The sealed `.apbundle` (signed manifest + payloads, encrypted to a key derived from the Update
 *   key), a content-free edge state, the `latest` pointer, and one note: the organization id. No prompt text in clear.
 * - **No list, no compare-and-set.** `z.cache` has get / set (with `nx`) / delete. `list` is an index key kept beside
 *   the entries; `ifVersion` is read-compare-write on a content hash. Two invocations racing can lose an index entry
 *   or a pointer move; the rows are immutable and the next successful fetch rewrites what is missing, so the worst
 *   case is one more fetch, never a wrong release (every read is verified again).
 *
 * @example
 * ```ts
 * const datastore = zapierDatastore(z.cache, connectionLabel({ updateKey, agentId, environment }));
 * const client = createAutomationClient({ agentId, updateKey, baseUrl, datastore });
 * ```
 */

import { createHash } from "node:crypto";
import { kvReleaseDatastore, type KvEntry, type KvPutCondition, type KvStore } from "@airprompter/agent-sdk/sync";
import type { AutomationDatastore } from "../core/index.js";

/** The slice of `z.cache` this needs (the real one, or the app tester's in-memory one). */
export interface ZapierCache {
  get(key: string, scope?: string[] | null): Promise<unknown>;
  set(key: string, value: unknown, ttl?: number | null, scope?: string[] | null, nx?: boolean | null): Promise<boolean | null>;
  delete(key: string, scope?: string[] | null): Promise<boolean>;
}

const SCOPE = ["auth"];
const versionOf = (value: string): string => createHash("sha256").update(value).digest("hex");

/** `KvStore` over `z.cache`: values are strings, versions are content hashes, `list` reads an index key. */
export function zcacheKvStore(cache: ZapierCache, namespace: string): KvStore {
  const keyOf = (key: string) => `ap:${namespace}:${key}`;
  const indexKey = `ap:${namespace}:__index`;
  const readIndex = async (): Promise<string[]> => {
    const raw = await cache.get(indexKey, SCOPE);
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : [];
  };
  const writeIndex = async (keys: string[]) => {
    await cache.set(indexKey, [...new Set(keys)].sort(), null, SCOPE);
  };
  return {
    async get(key): Promise<KvEntry | null> {
      const value = await cache.get(keyOf(key), SCOPE);
      return typeof value === "string" ? { value, version: versionOf(value) } : null;
    },
    async put(key: string, value: string, condition: KvPutCondition): Promise<boolean> {
      const current = await cache.get(keyOf(key), SCOPE);
      const held = typeof current === "string" ? current : null;
      if ("ifAbsent" in condition) {
        if (held !== null) return false;
        // `nx`: a racing writer that got there first wins; the loser sees false, as the contract asks.
        if ((await cache.set(keyOf(key), value, null, SCOPE, true)) === false) return false;
      } else {
        if (held === null || versionOf(held) !== condition.ifVersion) return false;
        await cache.set(keyOf(key), value, null, SCOPE);
      }
      const index = await readIndex();
      if (!index.includes(key)) await writeIndex([...index, key]);
      return true;
    },
    async list(prefix) {
      return (await readIndex()).filter((key) => key.startsWith(prefix));
    },
    async delete(key) {
      await cache.delete(keyOf(key), SCOPE);
      const index = await readIndex();
      if (index.includes(key)) await writeIndex(index.filter((k) => k !== key));
    },
  };
}

/** The release datastore the automation client reads and writes, plus its one note (the organization id). */
export function zapierDatastore(cache: ZapierCache, namespace: string): AutomationDatastore {
  const datastore = kvReleaseDatastore(zcacheKvStore(cache, namespace)) as AutomationDatastore;
  datastore.readNote = async (name) => {
    const value = await cache.get(`ap:${namespace}:note:${name}`, SCOPE);
    return typeof value === "string" ? value : null;
  };
  datastore.writeNote = async (name, value) => {
    await cache.set(`ap:${namespace}:note:${name}`, value, null, SCOPE);
  };
  return datastore;
}
