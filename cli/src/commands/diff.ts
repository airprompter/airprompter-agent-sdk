/**
 * `airprompter diff <bundle>`: what applying the bundle would change on this
 * host, slot by slot — versions, models, variable contracts, workflow
 * steps, experiment, directives, policy and lease. Identities and counts
 * only; the prompt text itself is never printed by this tool.
 *
 * `airprompter diff <bundle> --against <other.apbundle>` (S7): the same
 * comparison between two update files and no store — what a pull request
 * that replaces the committed bundle changes, for review in CI. Both files
 * are verified (scope, and the distribution key when sealed) before they
 * are compared; a bundle that goes BACKWARDS in generation is named as
 * such, because merging it would be refused on every host.
 */

import { existsSync, readFileSync } from "node:fs";

import type { Bundle, Manifest, ManifestSlot } from "../../../sdk-typescript/src/protocol/types.js";
import { isStoreError } from "../../../sdk-typescript/src/store/slotStore.js";
import { COMMON_OPTIONS, SCOPE_OPTIONS, STORE_OPTIONS, flag, helpFor, openStore, parse, scopeOf, str, type OptionSpec } from "../args.js";
import { openBundleFile } from "../chain.js";
import { EXIT, Output, refused, usage, type Context } from "../io.js";
import { loadDistributionPrivateKey } from "../keys.js";

export const DIFF_OPTIONS: OptionSpec = {
  ...SCOPE_OPTIONS,
  ...STORE_OPTIONS,
  "distribution-key": { type: "string", help: "Distribution PRIVATE key file (.key.json) for an encrypted bundle" },
  against: { type: "string", help: "Compare against this update file instead of the host's store (a pull request review; no store needed)" },
  ...COMMON_OPTIONS,
};

export interface SlotChange {
  tag: string;
  change: "added" | "removed" | "changed" | "unchanged";
  from?: SlotFacts;
  to?: SlotFacts;
  fields?: string[];
}

interface SlotFacts {
  kind: string;
  versionId: string;
  versionOrdinal: number | null;
  model: string;
  contentHash: string;
  byteLength: number;
  variables: Array<{ name: string; required: boolean; trust: string }>;
  steps: number;
}

const facts = (slot: ManifestSlot): SlotFacts => ({
  kind: slot.kind,
  versionId: slot.versionId,
  versionOrdinal: slot.versionOrdinal,
  model: slot.model,
  contentHash: slot.contentHash,
  byteLength: slot.byteLength,
  variables: slot.variables.map((v) => ({ name: v.name, required: v.required, trust: v.trust })),
  steps: slot.steps?.length ?? 0,
});

export function diffManifests(from: Manifest | null, to: Manifest): { slots: SlotChange[]; release: Record<string, { from: unknown; to: unknown }> } {
  const before = new Map((from?.payload.slots ?? []).map((slot) => [slot.tag, slot]));
  const after = new Map(to.payload.slots.map((slot) => [slot.tag, slot]));
  const tags = [...new Set([...before.keys(), ...after.keys()])].sort();
  const slots: SlotChange[] = tags.map((tag) => {
    const a = before.get(tag);
    const b = after.get(tag);
    if (!a) return { tag, change: "added", to: facts(b!) };
    if (!b) return { tag, change: "removed", from: facts(a) };
    const fa = facts(a);
    const fb = facts(b);
    const fields = (Object.keys(fa) as Array<keyof SlotFacts>).filter((key) => JSON.stringify(fa[key]) !== JSON.stringify(fb[key]));
    return fields.length ? { tag, change: "changed", from: fa, to: fb, fields } : { tag, change: "unchanged" };
  });
  const release: Record<string, { from: unknown; to: unknown }> = {};
  const compare = (key: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) release[key] = { from: a, to: b };
  };
  const p = from?.payload ?? null;
  const q = to.payload;
  compare("generation", p?.generation ?? null, q.generation);
  compare("releaseDigest", p?.releaseDigest ?? null, q.releaseDigest);
  compare("applyPolicy", p?.applyPolicy ?? null, q.applyPolicy);
  compare("leaseSeconds", p?.leaseSeconds ?? null, q.leaseSeconds);
  compare("onLeaseExpiry", p?.onLeaseExpiry ?? null, q.onLeaseExpiry);
  compare("requireCountersign", p?.requireCountersign ?? null, q.requireCountersign);
  compare("experiment", p?.experiment ? { experimentId: p.experiment.experimentId, arms: p.experiment.arms.map((arm) => ({ arm: arm.arm, weightBps: arm.weightBps, overrides: arm.overrides.map((o) => `${o.tag}@${o.versionId}`) })) } : null, q.experiment ? { experimentId: q.experiment.experimentId, arms: q.experiment.arms.map((arm) => ({ arm: arm.arm, weightBps: arm.weightBps, overrides: arm.overrides.map((o) => `${o.tag}@${o.versionId}`) })) } : null);
  compare("directives", p?.directives ?? null, q.directives);
  return { slots, release };
}

export async function diff(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, DIFF_OPTIONS);
  if (flag(parsed, "help") || parsed.positionals.length !== 1) {
    ctx.stdout(helpFor("diff", "<bundle.apbundle> --org … --agent … --environment … [--state-dir … | --against <other.apbundle>]", DIFF_OPTIONS));
    return flag(parsed, "help") ? EXIT.ok : EXIT.usage;
  }
  const out = new Output(ctx, flag(parsed, "json"));
  const scope = scopeOf(parsed);
  const path = parsed.positionals[0]!;
  if (!existsSync(path)) throw usage(`${path} does not exist`);
  const now = new Date(ctx.now()).toISOString();
  const keyPath = str(parsed, "distribution-key");
  let opened: ReturnType<typeof openBundleFile>;
  try {
    opened = openBundleFile(JSON.parse(readFileSync(path, "utf8")) as Bundle, scope, keyPath ? loadDistributionPrivateKey(keyPath) : undefined, now);
  } catch (error) {
    throw refused(`bundle: ${(error as Error).message}`, { reason: (error as { code?: string }).code ?? "malformed" });
  }
  let current: Manifest | null = null;
  const againstPath = str(parsed, "against");
  if (againstPath !== undefined) {
    // S7: two update files, no store — the pull request's before and after.
    if (!existsSync(againstPath)) throw usage(`${againstPath} does not exist`);
    try {
      current = openBundleFile(JSON.parse(readFileSync(againstPath, "utf8")) as Bundle, scope, keyPath ? loadDistributionPrivateKey(keyPath) : undefined, now).contents.manifest;
    } catch (error) {
      throw refused(`against: ${(error as Error).message}`, { reason: (error as { code?: string }).code ?? "malformed" });
    }
    const from = current.payload.generation;
    const to = opened.contents.manifest.payload.generation;
    out.set("direction", to > from ? "forward" : to === from ? "same" : "backward");
    if (to < from) out.line(`warning: ${path} is generation ${to}, behind ${againstPath} at ${from} — every host refuses a bundle that moves it backwards (a rollback is \`airprompter rollback\`, never an older bundle)`);
  } else {
    let store;
    try {
      store = await openStore(parsed, ctx, scope);
    } catch (error) {
      if (isStoreError(error)) throw refused(`store: ${error.message}`, { reason: error.code });
      throw error;
    }
    if (store.state.active) {
      try {
        current = store.load(store.state.active, { now, root: store.state.root, expectGeneration: store.state.generation }).manifest;
      } catch (error) {
        out.line(`active slot does not verify (${(error as Error).message}); diffing against nothing`);
      }
    }
  }
  const result = diffManifests(current, opened.contents.manifest);
  out.set("from", current ? { generation: current.payload.generation, releaseDigest: current.payload.releaseDigest } : null);
  out.set("to", { generation: opened.contents.manifest.payload.generation, releaseDigest: opened.contents.manifest.payload.releaseDigest });
  out.set("release", result.release);
  out.set("slots", result.slots);
  out.line(current ? `from generation ${current.payload.generation} to ${opened.contents.manifest.payload.generation}` : `nothing active on this host; everything in generation ${opened.contents.manifest.payload.generation} is new`);
  for (const [key, change] of Object.entries(result.release)) {
    if (key === "generation" || key === "releaseDigest") continue;
    out.line(`  ${key}: ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`);
  }
  for (const change of result.slots) {
    if (change.change === "unchanged") continue;
    if (change.change === "added") out.line(`  + ${change.tag}  ${change.to!.kind} ${change.to!.versionId} (v${change.to!.versionOrdinal}) on ${change.to!.model}, ${change.to!.variables.length} variables${change.to!.steps ? `, ${change.to!.steps} steps` : ""}`);
    else if (change.change === "removed") out.line(`  - ${change.tag}  ${change.from!.versionId}`);
    else {
      const parts = change.fields!.map((field) => {
        const a = change.from![field as keyof SlotFacts];
        const b = change.to![field as keyof SlotFacts];
        if (field === "variables") {
          const names = (v: SlotFacts["variables"]) => v.map((x) => `${x.name}${x.required ? "" : "?"}:${x.trust}`);
          return `variables ${names(a as SlotFacts["variables"]).join(",") || "—"} → ${names(b as SlotFacts["variables"]).join(",") || "—"}`;
        }
        if (field === "contentHash") return "content";
        return `${field} ${String(a)} → ${String(b)}`;
      });
      out.line(`  ~ ${change.tag}  ${parts.join("; ")}`);
    }
  }
  const changed = result.slots.filter((s) => s.change !== "unchanged").length;
  out.line(`${changed} slot${changed === 1 ? "" : "s"} changed, ${result.slots.length - changed} unchanged`);
  out.flush();
  return EXIT.ok;
}
