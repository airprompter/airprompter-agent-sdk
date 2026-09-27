/**
 * `@airprompter/datastore-redis` — the release datastore's `KvStore` over
 * Redis (T40, `protocol/datastore-format.md`). No client is bundled: hand in
 * a function that sends one raw command — `fromNodeRedis(client)` for
 * `redis` v4+, `fromIoRedis(client)` for `ioredis`, or your own — and the
 * adapter keeps the contract with three small Lua scripts (a conditional
 * write is one atomic `EVAL`). Each key is a hash (`value`, `version`, a
 * counter); a sorted set indexes the keys so `list` is an exact prefix
 * range, never a `SCAN` glob. Every key carries one hash tag (`{namespace}`),
 * so a Redis Cluster keeps them in one slot. Redis 6.2 or later, or Valkey.
 *
 * Durability is Redis's: run it with AOF (`appendonly yes`) or accept that a
 * restart loses the rows — the runtimes keep serving from their own stores
 * and the next pull writes the release again.
 *
 * @example
 * ```ts
 * import { createClient } from "redis";
 * import { kvReleaseDatastore } from "@airprompter/agent-sdk";
 * import { redisKvStore, fromNodeRedis } from "@airprompter/datastore-redis";
 *
 * const client = await createClient({ url: process.env.REDIS_URL }).connect();
 * const datastore = kvReleaseDatastore(redisKvStore({ command: fromNodeRedis(client) }));
 * ```
 */

import type { KvEntry, KvPutCondition, KvStore } from "@airprompter/agent-sync";

/** Send one command, e.g. `["HMGET", key, "value", "version"]`; resolve with the reply as the client decodes it. */
export type RedisCommand = (args: string[]) => Promise<unknown>;

/** `redis` (node-redis) v4+: `client.sendCommand(args)`. */
export function fromNodeRedis(client: { sendCommand(args: string[]): Promise<unknown> }): RedisCommand {
  return (args) => client.sendCommand(args);
}

/** `ioredis`: `client.call(command, ...args)`. */
export function fromIoRedis(client: { call(command: string, ...args: string[]): Promise<unknown> }): RedisCommand {
  return ([command, ...args]) => client.call(command!, ...args);
}

export interface RedisKvStoreOptions {
  command: RedisCommand;
  /** Every Redis key is `{namespace}:…` — one hash tag, one cluster slot. `airprompter` unless told otherwise. */
  namespace?: string;
  /** How many index entries one `list` round trip reads. */
  listBatch?: number;
}

// KEYS[1] the entry hash, KEYS[2] the index; ARGV[1] the value, ARGV[2] the logical key.
const PUT_IF_ABSENT = `if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('HSET', KEYS[1], 'value', ARGV[1], 'version', '1')
redis.call('ZADD', KEYS[2], 0, ARGV[2])
return 1`;
// ARGV[3] the version read.
const PUT_IF_VERSION = `local current = redis.call('HGET', KEYS[1], 'version')
if not current or current ~= ARGV[3] then return 0 end
redis.call('HSET', KEYS[1], 'value', ARGV[1], 'version', tostring(tonumber(current) + 1))
return 1`;
const DELETE = `redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1`;

const asNumber = (reply: unknown): number => (typeof reply === "number" ? reply : Number(reply));
const asText = (reply: unknown): string | null => (reply === null || reply === undefined ? null : typeof reply === "string" ? reply : Buffer.isBuffer(reply) ? reply.toString("utf8") : String(reply));

export function redisKvStore(options: RedisKvStoreOptions): KvStore {
  const namespace = options.namespace ?? "airprompter";
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(namespace)) throw new Error(`not a namespace: ${JSON.stringify(namespace)}`);
  const tag = `{${namespace}}`;
  const indexKey = `${tag}:index`;
  const entryKey = (key: string) => `${tag}:v:${key}`;
  const batch = Math.max(1, options.listBatch ?? 500);
  const { command } = options;
  return {
    async get(key: string): Promise<KvEntry | null> {
      const reply = (await command(["HMGET", entryKey(key), "value", "version"])) as unknown[];
      const value = asText(reply?.[0]);
      const version = asText(reply?.[1]);
      return value === null || version === null ? null : { value, version };
    },
    async put(key: string, value: string, condition: KvPutCondition): Promise<boolean> {
      const reply =
        "ifAbsent" in condition
          ? await command(["EVAL", PUT_IF_ABSENT, "2", entryKey(key), indexKey, value, key])
          : await command(["EVAL", PUT_IF_VERSION, "2", entryKey(key), indexKey, value, key, condition.ifVersion]);
      return asNumber(reply) === 1;
    },
    async list(prefix: string): Promise<string[]> {
      // The index is ordered byte-wise, so every key with the prefix sits in one run right after `[prefix`.
      const keys: string[] = [];
      let offset = 0;
      for (;;) {
        const reply = (await command(["ZRANGEBYLEX", indexKey, prefix === "" ? "-" : `[${prefix}`, "+", "LIMIT", String(offset), String(batch)])) as unknown[];
        const page = (reply ?? []).map((member) => asText(member) ?? "");
        for (const key of page) {
          if (!key.startsWith(prefix)) return keys;
          keys.push(key);
        }
        if (page.length < batch) return keys;
        offset += page.length;
      }
    },
    async delete(key: string): Promise<void> {
      await command(["EVAL", DELETE, "2", entryKey(key), indexKey, key]);
    },
  };
}
