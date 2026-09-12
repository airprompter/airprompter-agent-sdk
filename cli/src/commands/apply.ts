/**
 * `airprompter apply <bundle>`: the same path a runtime takes — open,
 * verify against `--root` and the store's generation counter, stage into
 * the inactive slot, then activate under `auto` or leave staged under
 * `unlock_required` (unlock is `airprompter unlock`, T9). `--force`
 * allows a generation below the stored one: a forced downgrade, stamped.
 */

import { existsSync, readFileSync } from "node:fs";

import type { Bundle } from "../../../sdk-typescript/src/protocol/types.js";
import { StoreError } from "../../../sdk-typescript/src/store/slotStore.js";
import { COMMON_OPTIONS, ROOT_OPTIONS, SCOPE_OPTIONS, STORE_OPTIONS, flag, helpFor, openStore, parse, rootOf, scopeOf, str, type OptionSpec } from "../args.js";
import { EXPIRY_WARNING_DAYS, openBundleFile, payloadsOf, verifyChain } from "../chain.js";
import { GOLDEN_OPTIONS, goldenInvokeOf, runGoldenSets } from "../golden.js";
import { CliError, EXIT, Output, refused, usage, type Context } from "../io.js";
import { loadDistributionPrivateKey } from "../keys.js";

export const APPLY_OPTIONS: OptionSpec = {
  ...SCOPE_OPTIONS,
  ...ROOT_OPTIONS,
  ...STORE_OPTIONS,
  "distribution-key": { type: "string", help: "Distribution PRIVATE key file (.key.json) for an encrypted bundle" },
  force: { type: "boolean", default: false, help: "Allow a generation below the stored one (forced downgrade, stamped on evidence)" },
  "stage-only": { type: "boolean", default: false, help: "Stage without activating even under an auto policy" },
  ...GOLDEN_OPTIONS,
  ...COMMON_OPTIONS,
};

export async function apply(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, APPLY_OPTIONS);
  if (flag(parsed, "help") || parsed.positionals.length !== 1) {
    ctx.stdout(helpFor("apply", "<bundle.apbundle> --org … --agent … --environment … --root … [--state-dir …]", APPLY_OPTIONS));
    return flag(parsed, "help") ? EXIT.ok : EXIT.usage;
  }
  const out = new Output(ctx, flag(parsed, "json"));
  const scope = scopeOf(parsed);
  const root = rootOf(parsed, scope.target);
  const path = parsed.positionals[0]!;
  if (!existsSync(path)) throw usage(`${path} does not exist`);
  const now = new Date(ctx.now()).toISOString();
  const keyPath = str(parsed, "distribution-key");
  const bundle = JSON.parse(readFileSync(path, "utf8")) as Bundle;
  let opened: ReturnType<typeof openBundleFile>;
  try {
    opened = openBundleFile(bundle, scope, keyPath ? loadDistributionPrivateKey(keyPath) : undefined, now);
  } catch (error) {
    throw refused(`bundle: ${(error as Error).message}`, { reason: (error as { code?: string }).code ?? "malformed" });
  }

  let store;
  try {
    store = await openStore(parsed, ctx, scope);
  } catch (error) {
    if (error instanceof StoreError) throw refused(`store: ${error.message}`, { reason: error.code });
    throw error;
  }
  const force = flag(parsed, "force");
  const stored = store.state.generation;
  const payloads = payloadsOf(opened.contents);
  const report = verifyChain({ manifest: opened.contents.manifest, keySet: opened.contents.keySet, payloads, root, scope, now, storedGeneration: force ? 0 : stored });
  if (!report.ok) throw new CliError(EXIT.refused, `refused at ${report.step}: ${report.reason}`, { step: report.step, reason: report.reason, root: report.root });
  const generation = opened.contents.manifest.payload.generation;
  if (generation === stored && store.state.active) {
    out.field("generation", generation);
    out.field("outcome", "unchanged");
    out.line("the store already holds this generation");
    out.flush();
    return EXIT.ok;
  }

  // The root the bundle carried was accepted against --root; the store remembers it for the runtime's next start.
  store.acceptRoot(report.trustedRoot);
  const slot = store.stage({ manifest: opened.contents.manifest, payloads, force });
  const policy = opened.contents.manifest.payload.applyPolicy;
  // T34: verified before activate — with --golden the cases run after staging and before activation, as the runtime does;
  // below the floor the release stays staged and the exit says so, whatever the policy.
  let goldenMet = true;
  if (flag(parsed, "golden")) {
    const concurrency = Number(str(parsed, "concurrency") ?? "4");
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw usage("--concurrency must be a whole number from 1 to 64");
    goldenMet = (await runGoldenSets({ manifest: opened.contents.manifest, payloads, invoke: goldenInvokeOf({ run: str(parsed, "run"), outputs: str(parsed, "outputs") }), concurrency, out })).met;
  }
  const activate = policy === "auto" && !flag(parsed, "stage-only") && goldenMet;
  if (activate) store.activate();
  out.field("store", store.dir);
  out.field("slot", slot);
  out.field("generation", generation);
  out.field("previousGeneration", stored, "previous generation");
  out.field("policy", policy);
  out.field("outcome", activate ? "activated" : "staged");
  out.field("forcedDowngrade", generation < stored, "forced downgrade");
  out.field("expired", opened.expired);
  if (opened.expired) out.line("warning: past notAfter — the runtime starts lease-expired on this release");
  else if (opened.daysLeft < EXPIRY_WARNING_DAYS) out.line(`warning: expires in ${opened.daysLeft} day${opened.daysLeft === 1 ? "" : "s"} — download a fresh update file before then`);
  out.set("daysLeft", opened.daysLeft);
  out.set("expiringSoon", !opened.expired && opened.daysLeft < EXPIRY_WARNING_DAYS);
  if (!goldenMet) out.line("staged: a golden set fell below its pass-rate floor — not activated (airprompter unlock activates it deliberately)");
  else if (!activate) out.line(policy === "unlock_required" ? "staged: this environment requires an unlock (airprompter unlock, or the runtime's apply.onStaged hook) before it serves" : "staged only (--stage-only)");
  out.set("goldenMet", goldenMet);
  out.flush();
  return goldenMet ? EXIT.ok : EXIT.refused;
}
