/**
 * `@airprompter/datastore-postgres` — the release datastore's `KvStore` over
 * one PostgreSQL table (T40, `protocol/datastore-format.md`). No driver is
 * bundled: hand in anything with `query(text, values)` — a `pg` Pool or
 * Client, `@neondatabase/serverless`, a Kysely/Drizzle escape hatch — and
 * the adapter keeps the contract with plain SQL: `INSERT … ON CONFLICT DO
 * NOTHING` for `ifAbsent`, `UPDATE … WHERE version = $n` for `ifVersion`
 * (the version is a counter bumped on every write), and an escaped `LIKE`
 * over a `text_pattern_ops` index for `list`. Postgres 11 or later.
 *
 * @example
 * ```ts
 * import pg from "pg";
 * import { kvReleaseDatastore, pullToDatastore } from "@airprompter/agent-sdk";
 * import { postgresKvStore } from "@airprompter/datastore-postgres";
 *
 * const kv = postgresKvStore({ client: new pg.Pool({ connectionString: process.env.DATABASE_URL }) });
 * await kv.ensureSchema(); // or run postgresKvSchema() in your own migrations
 * const datastore = kvReleaseDatastore(kv);
 * ```
 */

import type { KvEntry, KvPutCondition, KvStore } from "@airprompter/agent-sync";

/** What the adapter calls: `pg`'s `Pool` / `Client` shape (`rowCount` may be null on some drivers for SELECT). */
export interface PostgresQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

export interface PostgresKvStoreOptions {
  client: PostgresQueryable;
  /** `name` or `schema.name`; `airprompter_kv` unless told otherwise. */
  table?: string;
}

export interface PostgresKvStore extends KvStore {
  /** Create the table and its prefix index when they are missing (idempotent). */
  ensureSchema(): Promise<void>;
  readonly table: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function quotedTable(table: string): { quoted: string; indexName: string } {
  const parts = table.split(".");
  if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part))) throw new Error(`not a table name: ${JSON.stringify(table)} (letters, digits and _; optionally schema.name)`);
  return { quoted: parts.map((part) => `"${part}"`).join("."), indexName: `"${parts[parts.length - 1]}_key_prefix"` };
}

/** The DDL the adapter needs, for teams that run migrations themselves. */
export function postgresKvSchema(table = "airprompter_kv"): string {
  const { quoted, indexName } = quotedTable(table);
  return [
    `CREATE TABLE IF NOT EXISTS ${quoted} (key text PRIMARY KEY, value text NOT NULL, version bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now())`,
    `CREATE INDEX IF NOT EXISTS ${indexName} ON ${quoted} (key text_pattern_ops)`,
  ].join(";\n");
}

/** `LIKE` with every wildcard in the prefix escaped: `%`, `_` and the escape character itself mean themselves. */
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function postgresKvStore(options: PostgresKvStoreOptions): PostgresKvStore {
  const table = options.table ?? "airprompter_kv";
  const { quoted } = quotedTable(table);
  const { client } = options;
  return {
    table,
    async ensureSchema() {
      for (const statement of postgresKvSchema(table).split(";\n")) await client.query(statement);
    },
    async get(key: string): Promise<KvEntry | null> {
      const result = await client.query(`SELECT value, version::text AS version FROM ${quoted} WHERE key = $1`, [key]);
      const row = result.rows[0];
      return row ? { value: String(row.value), version: String(row.version) } : null;
    },
    async put(key: string, value: string, condition: KvPutCondition): Promise<boolean> {
      if ("ifAbsent" in condition) {
        const result = await client.query(`INSERT INTO ${quoted} (key, value, version) VALUES ($1, $2, 1) ON CONFLICT (key) DO NOTHING`, [key, value]);
        return result.rowCount === 1;
      }
      // A version this adapter never issued cannot match; never let it reach the cast.
      if (!/^\d{1,19}$/.test(condition.ifVersion)) return false;
      const result = await client.query(`UPDATE ${quoted} SET value = $2, version = version + 1, updated_at = now() WHERE key = $1 AND version = $3::bigint`, [key, value, condition.ifVersion]);
      return result.rowCount === 1;
    },
    async list(prefix: string): Promise<string[]> {
      const result = await client.query(`SELECT key FROM ${quoted} WHERE key LIKE $1 ESCAPE '\\'`, [likePrefix(prefix)]);
      // Belt and braces: an exact prefix match whatever the collation made of LIKE.
      return result.rows.map((row) => String(row.key)).filter((key) => key.startsWith(prefix));
    },
    async delete(key: string): Promise<void> {
      await client.query(`DELETE FROM ${quoted} WHERE key = $1`, [key]);
    },
  };
}
