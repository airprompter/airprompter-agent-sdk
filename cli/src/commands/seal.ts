/**
 * `airprompter seal verify --copy <file>`: recompute a customer-store seal (`protocol/pins.md` › "Customer-store
 * seal") against this host's own active release, offline — the same `verifySeal` the SDK runs on every mirror
 * tick (`sdk-typescript/packages/core/src/protocol/seal.ts`), over a `MirrorCopy` JSON file
 * (`{ sealId, pins, texts }`) exported from wherever the application keeps its mirror. Read-only: the store is
 * opened but never staged, activated or written to, and nothing printed is prompt text — `changedTags` names
 * pins and steps, never their content.
 *
 * @example
 * ```sh
 * airprompter seal verify --copy mirror-copy.json --agent agt_… --environment prod
 * airprompter seal verify --copy mirror-copy.json --agent agt_… --environment prod --json
 * ```
 */

import { readFileSync } from "node:fs";

import { verifySeal, type VerifySealInput } from "../../../sdk-typescript/packages/core/src/protocol/seal.js";
import { isStoreError } from "../../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { COMMON_OPTIONS, SCOPE_OPTIONS, STORE_OPTIONS, flag, helpFor, openStore, parse, scopeOf, str, type OptionSpec } from "../args.js";
import { CliError, EXIT, Output, refused, type Context } from "../io.js";

export const SEAL_VERIFY_OPTIONS: OptionSpec = {
  agent: SCOPE_OPTIONS.agent!,
  environment: SCOPE_OPTIONS.environment!,
  org: { type: "string", help: "Organization id (optional for seal verify)" },
  copy: { type: "string", help: "A MirrorCopy JSON file: { sealId, pins, texts } — the application's own copy of a release" },
  ...STORE_OPTIONS,
  ...COMMON_OPTIONS,
};

async function verify(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, SEAL_VERIFY_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("seal verify", "--copy <file> --agent … --environment … [--state-dir …]", SEAL_VERIFY_OPTIONS));
    return EXIT.ok;
  }
  const out = new Output(ctx, flag(parsed, "json"));
  const scope = scopeOf({ ...parsed, values: { ...parsed.values, org: parsed.values.org ?? "-" } });
  const copyPath = str(parsed, "copy");
  if (copyPath === undefined) throw new CliError(EXIT.usage, "--copy <file> is required");

  let copy: Pick<VerifySealInput, "sealId" | "pins" | "texts">;
  try {
    const parsedCopy = JSON.parse(readFileSync(copyPath, "utf8")) as { sealId?: unknown; pins?: unknown; texts?: unknown };
    if (typeof parsedCopy.sealId !== "string" || !Array.isArray(parsedCopy.pins) || typeof parsedCopy.texts !== "object" || parsedCopy.texts === null) {
      throw new Error("expected { sealId: string, pins: [...], texts: {...} }");
    }
    copy = { sealId: parsedCopy.sealId, pins: parsedCopy.pins as VerifySealInput["pins"], texts: parsedCopy.texts as VerifySealInput["texts"] };
  } catch (error) {
    throw new CliError(EXIT.usage, `--copy ${copyPath}: ${(error as Error).message}`);
  }

  let store;
  try {
    store = await openStore(parsed, ctx, scope);
  } catch (error) {
    if (isStoreError(error)) throw refused(`store: ${error.message}`, { reason: error.code });
    throw error;
  }
  if (!store.state.active) throw new CliError(EXIT.usage, "no active release on this host — nothing to verify the copy against");
  const active = store.load(store.state.active, { now: new Date(ctx.now()).toISOString(), root: store.state.root, expectGeneration: store.state.generation });

  const result = verifySeal({ sealId: copy.sealId, sealedPins: active.manifest.payload.slots, pins: copy.pins, texts: copy.texts });
  out.field("sealId", copy.sealId);
  out.field("observedDigest", result.observedDigest);
  out.field("intact", result.intact);
  out.field("changedTags", result.changedTags);
  out.line(result.intact ? `intact: the copy matches seal ${copy.sealId}` : `broken: ${result.changedTags.length} tag${result.changedTags.length === 1 ? "" : "s"} changed (${result.changedTags.join(", ")}) — observed ${result.observedDigest}`);
  out.flush();
  return result.intact ? EXIT.ok : EXIT.refused;
}

export async function seal(argv: string[], ctx: Context): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === "verify") return verify(rest, ctx);
  throw new CliError(EXIT.usage, `seal takes "verify --copy <file>"`);
}
