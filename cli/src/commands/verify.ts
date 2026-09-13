/**
 * `airprompter verify <bundle | state-dir>`: the T5 chain, with reasons.
 * A bundle is opened (decrypted with `--distribution-key` when sealed) and
 * verified against `--root`; a state directory has its active and staged
 * slots re-verified the way the runtime does at start.
 */

import { existsSync, readFileSync, statSync } from "node:fs";

import type { Bundle } from "../../../sdk-typescript/src/protocol/types.js";
import { SlotStore, isStoreError } from "../../../sdk-typescript/src/store/slotStore.js";
import { fileKey } from "../../../sdk-typescript/src/store/keyProvider.js";
import { join } from "node:path";
import { COMMON_OPTIONS, ROOT_OPTIONS, SCOPE_OPTIONS, flag, helpFor, parse, rootOf, scopeOf, str, type OptionSpec } from "../args.js";
import { EXPIRY_WARNING_DAYS, openBundleFile, payloadsOf, summarizeManifest, verifyChain, type ChainReport } from "../chain.js";
import { GOLDEN_OPTIONS, goldenInvokeOf, runGoldenSets } from "../golden.js";
import { EXIT, Output, refused, usage, type Context } from "../io.js";
import { loadDistributionPrivateKey } from "../keys.js";

export const VERIFY_OPTIONS: OptionSpec = {
  ...SCOPE_OPTIONS,
  ...ROOT_OPTIONS,
  "distribution-key": { type: "string", help: "Distribution PRIVATE key file (.key.json) for an encrypted bundle" },
  ...GOLDEN_OPTIONS,
  ...COMMON_OPTIONS,
};

function goldenConcurrency(parsed: ReturnType<typeof parse>): number {
  const value = Number(str(parsed, "concurrency") ?? "4");
  if (!Number.isInteger(value) || value < 1 || value > 64) throw usage("--concurrency must be a whole number from 1 to 64");
  return value;
}

function printReport(out: Output, report: ChainReport): void {
  out.field("ok", report.ok);
  out.field("step", report.step);
  out.field("reason", report.reason);
  out.set("root", report.root);
  out.line(`root: ${report.root.trusted}, ${report.root.accepted ? "accepted" : `refused (${report.root.reason})`}${report.root.version !== null ? `, version ${report.root.version}, expires ${report.root.expires}` : ""}`);
  if (report.manifest) {
    out.set("manifest", report.manifest);
    const m = report.manifest;
    out.line(`manifest: generation ${m.generation}, release ${m.releaseDigest}, ${m.slots} slot${m.slots === 1 ? "" : "s"} (${m.workflows} workflow${m.workflows === 1 ? "" : "s"}), ${m.payloads} payload${m.payloads === 1 ? "" : "s"}, policy ${m.applyPolicy}, lease ${m.leaseSeconds}s → ${m.onLeaseExpiry}`);
    if (m.experiment) out.line(`experiment: ${m.experiment.experimentId} (${m.experiment.arms.map((arm) => `${arm.arm} ${arm.weightBps / 100}%`).join(", ")})`);
    if (m.directives.length) out.line(`directives: ${m.directives.map((d) => `${d.kind}${d.scope ? ` ${d.scope}` : ""}${d.tag ? ` ${d.tag}` : ""}`).join(", ")}`);
  }
  out.field("signingKeyId", report.signingKeyId, "signed by");
}

export async function verify(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, VERIFY_OPTIONS);
  if (flag(parsed, "help") || parsed.positionals.length !== 1) {
    ctx.stdout(helpFor("verify", "<bundle.apbundle | state-dir> --org … --agent … --environment … --root …", VERIFY_OPTIONS));
    return flag(parsed, "help") ? EXIT.ok : EXIT.usage;
  }
  const out = new Output(ctx, flag(parsed, "json"));
  const scope = scopeOf(parsed);
  const root = rootOf(parsed, scope.target);
  const path = parsed.positionals[0]!;
  if (!existsSync(path)) throw usage(`${path} does not exist`);
  const now = new Date(ctx.now()).toISOString();

  if (statSync(path).isDirectory()) {
    let store: SlotStore;
    try {
      store = await SlotStore.open({ stateDir: path, agentId: scope.agentId, target: scope.target, keyProvider: fileKey(join(SlotStore.path({ stateDir: path, agentId: scope.agentId, target: scope.target }), "store.key")) });
    } catch (error) {
      if (isStoreError(error)) throw refused(`store: ${error.message}`, { reason: error.code });
      throw error;
    }
    const state = store.state;
    out.field("store", store.dir);
    out.field("storageProtection", store.storageProtection, "storage protection");
    const trusted = root.kind === "pinned" ? root.trusted : root.document;
    const results: Record<string, unknown> = {};
    let allOk = true;
    const golden = flag(parsed, "golden") ? goldenInvokeOf({ run: str(parsed, "run"), outputs: str(parsed, "outputs") }) : null;
    for (const [label, slot] of [["active", state.active], ["staged", state.staged]] as const) {
      if (!slot || (label === "staged" && slot === state.active)) continue;
      try {
        const loaded = store.load(slot, { now, root: state.root ?? trusted, ...(label === "active" ? { expectGeneration: state.generation } : {}) });
        const report = verifyChain({ manifest: loaded.manifest, keySet: state.root, payloads: loaded.payloads, root, scope, now, storedGeneration: 0 });
        results[label] = { slot, ...report, trustedRoot: undefined };
        out.line(`${label} slot ${slot}: ${report.ok ? "verified" : `REFUSED at ${report.step} (${report.reason})`}, generation ${loaded.generation}`);
        if (!report.ok) allOk = false;
        // T34: the chain first; the cases only on a release that verified (the staged one is what an unlock would activate).
        else if (golden && (label === "staged" || !state.staged || state.staged === state.active)) {
          const ran = await runGoldenSets({ manifest: loaded.manifest, payloads: loaded.payloads, invoke: golden, concurrency: goldenConcurrency(parsed), out });
          if (!ran.met) allOk = false;
        }
      } catch (error) {
        allOk = false;
        const reason = isStoreError(error) ? `${error.code}${error.detail ? `/${error.detail}` : ""}` : (error as Error).message;
        results[label] = { slot, ok: false, reason };
        out.line(`${label} slot ${slot}: REFUSED (${reason})`);
      }
    }
    if (!state.active) out.line("no active release");
    out.set("slots", results);
    out.field("generation", state.generation);
    out.field("forcedDowngrade", state.forcedDowngrade === true, "forced downgrade");
    out.flush({ ok: allOk && state.active !== null });
    return allOk && state.active !== null ? EXIT.ok : EXIT.refused;
  }

  const bundle = JSON.parse(readFileSync(path, "utf8")) as Bundle;
  const keyPath = str(parsed, "distribution-key");
  let opened: ReturnType<typeof openBundleFile>;
  try {
    opened = openBundleFile(bundle, scope, keyPath ? loadDistributionPrivateKey(keyPath) : undefined, now);
  } catch (error) {
    const code = (error as { code?: string }).code ?? "malformed";
    out.field("ok", false);
    out.field("step", "bundle");
    out.field("reason", code);
    out.flush();
    ctx.stderr(`refused: ${(error as Error).message}`);
    return EXIT.refused;
  }
  const report = verifyChain({ manifest: opened.contents.manifest, keySet: opened.contents.keySet, payloads: payloadsOf(opened.contents), root, scope, now, storedGeneration: 0 });
  out.field("encryption", opened.encryption);
  out.field("recipientKeyId", opened.recipientKeyId, "recipient key");
  out.field("notAfter", opened.contents.notAfter, "not after");
  if (opened.expired) out.line("warning: past notAfter — a runtime applying this bundle starts lease-expired");
  else if (opened.daysLeft < EXPIRY_WARNING_DAYS) out.line(`warning: expires in ${opened.daysLeft} day${opened.daysLeft === 1 ? "" : "s"} — download a fresh update file before then`);
  out.set("expired", opened.expired);
  out.set("daysLeft", opened.daysLeft);
  out.set("expiringSoon", !opened.expired && opened.daysLeft < EXPIRY_WARNING_DAYS);
  printReport(out, { ...report, manifest: summarizeManifest(opened.contents.manifest) });
  // T34: with --golden, a verified bundle's cases run here, offline, exactly as a runtime would run them before activation.
  let goldenMet = true;
  if (report.ok && flag(parsed, "golden")) {
    const ran = await runGoldenSets({ manifest: opened.contents.manifest, payloads: payloadsOf(opened.contents), invoke: goldenInvokeOf({ run: str(parsed, "run"), outputs: str(parsed, "outputs") }), concurrency: goldenConcurrency(parsed), out });
    goldenMet = ran.met;
  }
  out.flush({ ok: report.ok && goldenMet });
  if (!report.ok) ctx.stderr(`refused at ${report.step}: ${report.reason}`);
  else if (!goldenMet) ctx.stderr("refused at golden: a golden set fell below its pass-rate floor");
  return report.ok && goldenMet ? EXIT.ok : EXIT.refused;
}
