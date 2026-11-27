/**
 * AirPrompter's hosted roots: the root public key each hosted environment's offline ceremony wrote, and the URL its
 * root document (the signing keys under that root) is served at.
 *
 * A key here is never trusted because it is here: a runtime trusts the root its caller pins. This table only says
 * where a pinned hosted root's document lives, so an agent started with `root: { pinned }` alone can learn the
 * signing keys. Whatever that URL returns must still verify against the pinned key (R1–R5) before it is used.
 *
 * @example
 * ```ts
 * const environment = hostedEnvironmentOfRoot(pinned); // "prod" for AirPrompter's production root, null for any other key
 * const rootUrl = environment ? HOSTED_ROOT_URLS[environment] : undefined;
 * ```
 */

import type { HostedEnvironment, P256PublicJwk } from "./types.js";
import { keyThumbprint } from "./trust.js";

/**
 * Exactly as the ceremonies wrote them (`infrastructure/trust/agent-root/{environment}/root-public.jwk.json` in the
 * service repository). An environment with no ceremony has no entry: `staging` has none.
 */
export const HOSTED_ROOTS: Partial<Record<HostedEnvironment, P256PublicJwk>> = {
  // Ceremony of 2026-09-14 (AIR-1935); key id 86267aa3dc49005a0c1474d5c9c06bd7e1d0e835da715a864c1eca706545df91.
  dev: { kty: "EC", crv: "P-256", x: "gAQGIbpqvkYwfGnz2yJjAFcMLZm43fsQ6zXF4CjImss", y: "ImPVZkVwb3KC73p9T3EBtGzhm-s-vI6VVu0ovgka6ek" },
  // Ceremony of 2026-11-27 (AIR-2214); key id 044af6e83353a2ea3758cc3feb3b1b7031c82bda5d6cd9287ba7730363e11793.
  prod: { kty: "EC", crv: "P-256", x: "hYhEFO-xyNoWyt5x0BgshEmNXPN1_mzDLISlT4nTDzE", y: "OTbj5sdj8qKiIPzCsrdD297_vlNqahPTZWGgoa9cOtE" },
};

/** Where each hosted environment's API serves its root document (`GET <api>/roots/<environment>/root.json`). */
export const HOSTED_ROOT_URLS: Readonly<Partial<Record<HostedEnvironment, string>>> = Object.freeze({
  dev: "https://api.airprompter.dev/roots/dev/root.json",
  prod: "https://api.airprompter.com/roots/prod/root.json",
});

/**
 * Where a runtime reads its root document, decided once at start. An explicit `rootUrl` wins. A runtime that never
 * syncs, and one handed a full root document (`pinned: null`), needs none. A pinned AirPrompter root gets its
 * environment's URL; any other pinned root has no default, so a runtime that would sync with it is refused with the
 * line to add, rather than started to never verify a release. The URL only says where to look: what it serves is
 * accepted only if it verifies against the pinned key.
 */
export function rootUrlFor(input: { rootUrl?: string | undefined; pinned: P256PublicJwk | null; hostedEnvironment?: HostedEnvironment | undefined; syncs: boolean }): { url: string | null; defaultFor: HostedEnvironment | null } | { refused: string } {
  if (input.rootUrl) return { url: input.rootUrl, defaultFor: null };
  if (!input.pinned || !input.syncs) return { url: null, defaultFor: null };
  const environment = input.hostedEnvironment ?? "prod";
  const named = hostedEnvironmentOfRoot(input.pinned);
  const url = named === environment ? HOSTED_ROOT_URLS[named] : undefined;
  if (url) return { url, defaultFor: environment };
  if (named !== null) {
    return { refused: `root.pinned is AirPrompter's ${named} root, but root.hostedEnvironment is "${environment}"${input.hostedEnvironment === undefined ? " (the default)" : ""}. Add hostedEnvironment: "${named}" to root, or pin the ${environment} root.` };
  }
  return { refused: `root.pinned is not one of AirPrompter's hosted roots, so the SDK cannot know where its root document is, and without it no release verifies. Add sync: { rootUrl: "https://<your service>/roots/${environment}/root.json" }, the root document of the service that signs your releases.` };
}

/** The hosted environment whose root this key is (by RFC 7638 thumbprint), or null for a key AirPrompter does not host. */
export function hostedEnvironmentOfRoot(pinned: P256PublicJwk): HostedEnvironment | null {
  let id: string;
  try {
    id = keyThumbprint(pinned);
  } catch {
    return null;
  }
  for (const [environment, key] of Object.entries(HOSTED_ROOTS) as Array<[HostedEnvironment, P256PublicJwk | undefined]>) {
    if (key && keyThumbprint(key) === id) return environment;
  }
  return null;
}
