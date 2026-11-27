/**
 * AirPrompter's hosted roots: the root public key each hosted environment's offline ceremony wrote.
 *
 * The agent never trusts a key because it is here: it trusts the root its caller pins, and uses this table only to
 * recognise a pin as AirPrompter's (and so know where that environment's root document is). The Steps client, which
 * keeps no files, pins the entry itself (`frameworks/steps`, `pinnedRootFor`). The table is frozen.
 *
 * @example
 * ```ts
 * hostedEnvironmentOfRoot(pinned); // "prod" for AirPrompter's production root, null for any other key
 * ```
 */

import type { HostedEnvironment, P256PublicJwk } from "./types.js";
import { keyThumbprint } from "./trust.js";

type HostedRoots = Readonly<Partial<Record<HostedEnvironment, Readonly<P256PublicJwk>>>>;

/**
 * Exactly as the ceremonies wrote them (`infrastructure/trust/agent-root/{environment}/root-public.jwk.json` in the
 * service repository). An environment with no ceremony has no entry: `staging` has none.
 */
export const HOSTED_ROOTS: HostedRoots = Object.freeze({
  // Ceremony of 2026-09-14 (AIR-1935); key id 86267aa3dc49005a0c1474d5c9c06bd7e1d0e835da715a864c1eca706545df91.
  dev: Object.freeze({ kty: "EC", crv: "P-256", x: "gAQGIbpqvkYwfGnz2yJjAFcMLZm43fsQ6zXF4CjImss", y: "ImPVZkVwb3KC73p9T3EBtGzhm-s-vI6VVu0ovgka6ek" } as const),
  // Ceremony of 2026-11-27 (AIR-2214); key id 044af6e83353a2ea3758cc3feb3b1b7031c82bda5d6cd9287ba7730363e11793.
  prod: Object.freeze({ kty: "EC", crv: "P-256", x: "hYhEFO-xyNoWyt5x0BgshEmNXPN1_mzDLISlT4nTDzE", y: "OTbj5sdj8qKiIPzCsrdD297_vlNqahPTZWGgoa9cOtE" } as const),
});

/** What `hostedEnvironmentOfRoot` recognises: `HOSTED_ROOTS`, unless a test stands its own fake in (`withHostedRootsForTests`). */
let recognised: HostedRoots = HOSTED_ROOTS;

/** The hosted environment whose root this key is (by RFC 7638 thumbprint), or null for a key AirPrompter does not host. */
export function hostedEnvironmentOfRoot(pinned: P256PublicJwk): HostedEnvironment | null {
  let id: string;
  try {
    id = keyThumbprint(pinned);
  } catch {
    return null;
  }
  for (const [environment, key] of Object.entries(recognised) as Array<[HostedEnvironment, P256PublicJwk | undefined]>) {
    if (key && keyThumbprint(key) === id) return environment;
  }
  return null;
}

/**
 * The repository's tests only (not exported from `/core`): a fake control plane cannot sign as AirPrompter, so a test of
 * the hosted path has its own root recognised as a hosted one for the length of `run`. It changes which pins count as
 * AirPrompter's, never what a pinned agent trusts.
 */
export async function withHostedRootsForTests<T>(roots: HostedRoots, run: () => Promise<T>): Promise<T> {
  const before = recognised;
  recognised = roots;
  try {
    return await run();
  } finally {
    recognised = before;
  }
}
