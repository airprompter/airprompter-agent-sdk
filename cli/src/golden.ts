/**
 * `--golden` on `verify` and `apply` (T34): run every golden set a release
 * carries against the model, on this host, before anything activates. The
 * model call is the operator's own — either `--run <command>`, a program run
 * once per case (the case as one JSON object on stdin: `{tag, caseId, text,
 * model, arm, variables}`; the model's answer on stdout), or `--outputs
 * <file>`, answers a harness already produced (`{"<tag>/<caseId>": "…"}` or
 * `{"<tag>": {"<caseId>": "…"}}`). Only counts are printed; an output never
 * is, and a failed expectation is named, not quoted.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { goldenReportsMeet, parseGoldenSet, runGoldenSet, type GoldenInvoke, type GoldenReport } from "../../sdk-typescript/packages/core/src/golden/index.js";
import type { Manifest, ManifestSlot } from "../../sdk-typescript/packages/core/src/protocol/types.js";
import type { OptionSpec } from "./args.js";
import { Output, usage } from "./io.js";

export const GOLDEN_OPTIONS: OptionSpec = {
  golden: { type: "boolean", default: false, help: "Run the release's golden sets against the model before the verdict (T34)" },
  run: { type: "string", help: "With --golden: a command run once per case (the case as JSON on stdin, the answer on stdout)" },
  outputs: { type: "string", help: "With --golden: a JSON file of answers a harness already produced, by \"<tag>/<caseId>\"" },
  concurrency: { type: "string", default: "4", help: "With --golden --run: cases in flight at once" },
};

/** The operator's model call, from `--run` or `--outputs`; a usage error when `--golden` has neither. */
export function goldenInvokeOf(input: { run: string | undefined; outputs: string | undefined }): GoldenInvoke {
  if (input.run && input.outputs) throw usage("--run and --outputs are alternatives");
  if (input.outputs) {
    if (!existsSync(input.outputs)) throw usage(`${input.outputs} does not exist`);
    const raw = JSON.parse(readFileSync(input.outputs, "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw usage(`${input.outputs}: not an object of answers`);
    return async ({ tag, caseId }) => {
      const flat = raw[`${tag}/${caseId}`];
      const nested = (raw[tag] as Record<string, unknown> | undefined)?.[caseId];
      const answer = flat ?? nested;
      if (typeof answer !== "string") throw new Error("no_output");
      return answer;
    };
  }
  if (input.run) {
    const command = input.run;
    return (invocation) =>
      new Promise((resolve, reject) => {
        const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
        const chunks: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new Error(`exit_${code}`))));
        child.stdin.end(`${JSON.stringify({ tag: invocation.tag, caseId: invocation.caseId, text: invocation.text, model: invocation.model, arm: invocation.arm, variables: invocation.variables })}\n`);
      });
  }
  throw usage("--golden needs --run <command> or --outputs <file>");
}

/** Every slot with a golden set — the control arm and each arm override — run in order; the reports and whether all met. */
export async function runGoldenSets(input: { manifest: Manifest; payloads: ReadonlyMap<string, Uint8Array>; invoke: GoldenInvoke; concurrency: number; out: Output }): Promise<{ reports: GoldenReport[]; met: boolean; unavailable: string[] }> {
  const payload = input.manifest.payload;
  const targets: Array<{ slot: ManifestSlot; arm: string }> = payload.slots.filter((slot) => slot.goldenSet).map((slot) => ({ slot, arm: "none" }));
  for (const arm of payload.experiment?.arms ?? []) for (const override of arm.overrides) if (override.goldenSet) targets.push({ slot: override, arm: arm.arm });
  const reports: GoldenReport[] = [];
  const unavailable: string[] = [];
  for (const { slot, arm } of targets) {
    const setBytes = input.payloads.get(slot.goldenSet!.contentHash);
    const text = input.payloads.get(slot.contentHash);
    if (!setBytes || !text) {
      unavailable.push(`${slot.tag}@${arm}`);
      continue;
    }
    const set = parseGoldenSet(setBytes, slot.goldenSet!);
    const report = await runGoldenSet({ slot, arm, text: Buffer.from(text).toString("utf8"), set, invoke: input.invoke, concurrency: input.concurrency });
    input.out.line(`golden ${slot.tag}${arm === "none" ? "" : ` (${arm})`}: ${report.passed}/${report.cases} passed, floor ${report.minPassBps / 100}% → ${report.meetsThreshold ? "met" : "NOT MET"}${report.failed ? ` — failed: ${report.results.filter((r) => !r.ok).map((r) => `${r.caseId}${r.error ? ` (${r.error})` : r.failed.length ? ` [${r.failed.join(", ")}]` : ""}`).join(", ")}` : ""}`);
    reports.push(report);
  }
  for (const name of unavailable) input.out.line(`golden ${name}: payload unavailable`);
  const met = goldenReportsMeet(reports) && unavailable.length === 0;
  input.out.set("golden", { met, sets: reports.length, unavailable, reports: reports.map((r) => ({ tag: r.tag, arm: r.arm, setId: r.setId, cases: r.cases, passed: r.passed, failed: r.failed, passBps: r.passBps, minPassBps: r.minPassBps, meetsThreshold: r.meetsThreshold, results: r.results })) });
  if (reports.length === 0 && unavailable.length === 0) input.out.line("golden: this release carries no golden set");
  return { reports, met, unavailable };
}
