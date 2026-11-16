/**
 * The platform-neutral half of a Steps datastore: the SDK's shared release format over any `KvStore`, with the
 * client's notes (the organization id) as keys beside the rows, and a vendored `.apbundle` written into it so a step
 * can serve before AirPrompter has ever answered. A platform supplies only the `KvStore` over its own storage (n8n:
 * the user folder or workflow static data; Zapier keeps its notes in `z.cache` directly).
 *
 * A seeded row is the bundle as signed: the client verifies it again on every load, exactly like one it fetched, so
 * a seed can never serve something a fetch would refuse. Seeding never overwrites a row already held.
 *
 * @example
 * ```ts
 * import { MemoryKvStore, kvAutomationDatastore, seedDatastoreFromBundle } from "@airprompter/agent-sdk/frameworks/steps";
 * const datastore = kvAutomationDatastore(new MemoryKvStore());
 * await seedDatastoreFromBundle(datastore, { bundle, agentId: "agt_1", environment: "prod" }); // true: seeded
 * ```
 */

import { openBundle } from "../../core/index.js";
import type { Bundle } from "../../core/index.js";
import { kvReleaseDatastore, rolloutOf } from "../../sync/index.js";
import type { KvStore } from "../../sync/index.js";

import type { AutomationDatastore } from "./types.js";

const NOTE_PREFIX = "automation/notes/";
const ORGANIZATION_NOTE = "organizationId";

/** The shared datastore format over any KvStore, plus the client's notes as keys beside it. */
export function kvAutomationDatastore(kv: KvStore): AutomationDatastore {
  const datastore = kvReleaseDatastore(kv) as AutomationDatastore;
  datastore.readNote = async (name) => (await kv.get(`${NOTE_PREFIX}${name}`))?.value ?? null;
  datastore.writeNote = async (name, value) => {
    const key = `${NOTE_PREFIX}${name}`;
    const held = await kv.get(key);
    if (held?.value === value) return;
    // Compare-and-set: two invocations racing to write the same note cannot clobber a different value unseen.
    await kv.put(key, value, held ? { ifVersion: held.version } : { ifAbsent: true });
  };
  return datastore;
}

/**
 * Write a vendored bundle into an empty datastore, scoped to `agentId` and `environment` (`openBundle` refuses another
 * scope). Returns false when a row is already held for that key: what AirPrompter served last wins over the seed.
 */
export async function seedDatastoreFromBundle(datastore: AutomationDatastore, input: { bundle: Bundle; agentId: string; environment: string }): Promise<boolean> {
  const contents = openBundle(input.bundle, { agentId: input.agentId, target: input.environment });
  const payload = contents.manifest.payload;
  const key = { organizationId: payload.organizationId, agentId: input.agentId, target: input.environment, region: null };
  if (await datastore.latest(key)) return false;
  await datastore.putRelease(key, { generation: payload.generation, releaseDigest: payload.releaseDigest, bundle: JSON.stringify(input.bundle), createdAt: contents.createdAt, notAfter: contents.notAfter, rollout: rolloutOf(contents.manifest) });
  if (!(await datastore.readNote?.(ORGANIZATION_NOTE))) await datastore.writeNote?.(ORGANIZATION_NOTE, payload.organizationId);
  return true;
}
