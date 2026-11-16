/**
 * A `KvStore` over n8n workflow static data — the storage an n8n Cloud workflow has without a disk. The SDK's
 * `kvReleaseDatastore` over it keeps the signed, sealed releases in the shared datastore format.
 *
 * Limits (n8n's, documented in the README): static data is saved with the workflow only after a production
 * execution (an active workflow started by its trigger, schedule or webhook) — never after a manual test run; it is
 * per workflow, so each workflow keeps its own copy; it sits in n8n's database beside the workflow, so it is kept
 * small (the core keeps two releases at most, sealed). Writes are conditional within one execution; two executions that run at
 * once each save their own copy and the later save wins, which is harmless — every row is immutable per generation
 * and verified on load.
 *
 * @example
 * ```ts
 * const kv = staticDataKvStore(this.getWorkflowStaticData("global"));
 * const datastore = kvReleaseDatastore(kv);
 * ```
 */

import { createHash } from "node:crypto";

import type { KvEntry, KvPutCondition, KvStore } from "@airprompter/agent-sdk/frameworks/steps";

/** The one key under the static data object that this integration owns. */
export const STATIC_DATA_KEY = "airprompter";

interface Cell {
  v: string;
  h: string;
}

const versionOf = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);

export function staticDataKvStore(staticData: Record<string, unknown>): KvStore {
  const cells = (): Record<string, Cell> => {
    const existing = staticData[STATIC_DATA_KEY];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) return existing as Record<string, Cell>;
    const created: Record<string, Cell> = {};
    staticData[STATIC_DATA_KEY] = created;
    return created;
  };
  return {
    async get(key: string): Promise<KvEntry | null> {
      const cell = cells()[key];
      return cell && typeof cell.v === "string" ? { value: cell.v, version: cell.h } : null;
    },
    async put(key: string, value: string, condition: KvPutCondition): Promise<boolean> {
      const store = cells();
      const current = store[key];
      if ("ifAbsent" in condition ? current !== undefined : current?.h !== condition.ifVersion) return false;
      // A new object, so n8n's change detection on the static data proxy sees the write.
      staticData[STATIC_DATA_KEY] = { ...store, [key]: { v: value, h: versionOf(value) } };
      return true;
    },
    async list(prefix: string): Promise<string[]> {
      return Object.keys(cells()).filter((key) => key.startsWith(prefix));
    },
    async delete(key: string): Promise<void> {
      const store = cells();
      if (!(key in store)) return;
      const next = { ...store };
      delete next[key];
      staticData[STATIC_DATA_KEY] = next;
    },
  };
}
