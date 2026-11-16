/**
 * The local registry the tests run against: `airprompter dev`'s own code (`cli/src/commands/dev.ts`) serving a
 * directory of prompt files over HTTP, signed under a dev root. `down()` / `up()` take it off and back on the same
 * port, which is what "AirPrompter unreachable" looks like to a Zapier step.
 */

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEV_API_KEY, devPlane, loadOrCreateDevKeys, promoteRelease, readDevRelease } from "../../../cli/src/commands/dev.js";
import { serveOverHttp } from "../../../sdk-typescript/packages/sdk/src/core/testing/controlPlane.js";
import { releaseDigest } from "../../../sdk-typescript/packages/sdk/src/core/index.js";
import type { ManifestSlot, P256PublicJwk } from "../../../sdk-typescript/packages/sdk/src/core/index.js";

export const SCOPE = { organizationId: "org_dev", agentId: "agt_dev", target: "dev" } as const;
export { DEV_API_KEY };

export async function startRegistry(files: Record<string, string>, options: { leaseSeconds?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ap-zapier-registry-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const { keys, rootPubPath } = loadOrCreateDevKeys(dir, SCOPE.target);
  const overrides = options.leaseSeconds ? { leaseSeconds: options.leaseSeconds } : {};
  const plane = devPlane({ scope: { ...SCOPE }, keys, release: readDevRelease(dir), overrides });
  let server = await serveOverHttp(plane, { port: 0 });
  const baseUrl = server.baseUrl;
  const port = Number(new URL(baseUrl).port);
  const wire = () => {
    // Upload grants and a reachable edge pointer, as the hosted service has them.
    plane.grantBaseUrl = baseUrl;
    plane.edgePointerUrl = `${baseUrl}/edge/${SCOPE.agentId}/${SCOPE.target}/generation.json`;
  };
  wire();
  let up = true;
  const root = JSON.parse(readFileSync(rootPubPath, "utf8")) as P256PublicJwk;
  return {
    dir,
    plane,
    baseUrl,
    root,
    /** Edit a prompt file and promote, as `airprompter dev`'s watcher does on save. */
    edit(path: string, text: string) {
      writeFileSync(join(dir, path), text);
      return promoteRelease(plane, readDevRelease(dir), overrides);
    },
    /** Promote slots built here (an A/B split, a hand-set version ordinal). */
    promote(slots: ManifestSlot[], extra: Parameters<typeof plane.promote>[1] = {}) {
      return plane.promote(slots, { ...overrides, ...extra });
    },
    releaseDigest,
    async down() {
      if (!up) return;
      up = false;
      await server.close();
    },
    async up() {
      if (up) return;
      server = await serveOverHttp(plane, { port });
      up = true;
    },
    async close() {
      if (up) await server.close();
      up = false;
    },
  };
}

export type Registry = Awaited<ReturnType<typeof startRegistry>>;

/** A two-arm split on one slot: the control is the slot as promoted, the candidate a second version. */
export function abRelease(registry: Registry, input: { tag: string; control: string; candidate: string; weights: [number, number]; variables?: ManifestSlot["variables"] }) {
  const control = registry.plane.slot({ tag: input.tag, text: input.control, versionId: `${input.tag}_v1`, variables: input.variables ?? [] });
  const candidate = registry.plane.slot({ tag: input.tag, text: input.candidate, versionId: `${input.tag}_v2`, variables: input.variables ?? [] });
  const arms = [
    { arm: "control", weightBps: input.weights[0], releaseDigest: releaseDigest([control]), overrides: [] },
    { arm: "candidate", weightBps: input.weights[1], releaseDigest: releaseDigest([candidate]), overrides: [candidate] },
  ];
  return { control, candidate, experiment: { tag: input.tag, experimentId: `exp_${input.tag.replace(/\W/g, "_")}`, salt: "AAECAwQFBgcICQoLDA0ODw", subjectKey: "request" as const, arms } };
}
