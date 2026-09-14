/**
 * `airprompter telemetry validate <segment>…` (S14): a third-party writer's
 * segment against the spool contract, line by line, exactly as the uploader
 * inspects it before an upload — the same `inspectSegment`, so a file that
 * passes here is never quarantined there. The instance id is the file
 * name's (authoritative for every row) unless `--instance-id` names it for
 * a file named otherwise; a partial last line (a crashed writer) is
 * reported, never counted invalid. Reasons name a field, never a value:
 * nothing here prints a row.
 *
 * Exit 0 when every segment fits; `refused` (1) when any line does not or a
 * segment is over the cap.
 */

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

import { SEGMENT_MAX_BYTES } from "../../../sdk-typescript/packages/telemetry/src/spool/writer.js";
import { SEGMENT_NAME, inspectSegment } from "../../../sdk-typescript/packages/telemetry/src/uploader.js";
import { COMMON_OPTIONS, flag, helpFor, parse, str, type OptionSpec } from "../args.js";
import { EXIT, Output, usage, type Context } from "../io.js";

export const TELEMETRY_VALIDATE_OPTIONS: OptionSpec = {
  "instance-id": { type: "string", help: "The writer's instance id when the file is not named seg-<instanceId>-<minute>-<n>.ndjson" },
  ...COMMON_OPTIONS,
};

export interface SegmentVerdict {
  path: string;
  instanceId: string | null;
  bytes: number;
  lines: number;
  rows: number;
  invalid: Array<{ line: number; reason: string }>;
  partialTail: boolean;
  oversize: boolean;
  ok: boolean;
}

export function validateSegmentFile(path: string, instanceIdOverride?: string): SegmentVerdict {
  const name = basename(path);
  const fromName = SEGMENT_NAME.exec(name)?.[1] ?? null;
  const instanceId = instanceIdOverride ?? fromName;
  const bytes = statSync(path).size;
  if (!instanceId) return { path, instanceId: null, bytes, lines: 0, rows: 0, invalid: [{ line: 0, reason: "segment_name" }], partialTail: false, oversize: bytes > SEGMENT_MAX_BYTES, ok: false };
  const data = readFileSync(path);
  const inspection = inspectSegment(data, instanceId);
  const text = data.toString("utf8");
  const lines = text.split("\n").filter((line, index, all) => index < all.length - 1 || line.length > 0).length;
  const oversize = bytes > SEGMENT_MAX_BYTES;
  return { path, instanceId, bytes, lines, rows: inspection.rows.length, invalid: inspection.invalid, partialTail: inspection.partialTail, oversize, ok: inspection.invalid.length === 0 && !oversize };
}

export async function telemetryValidate(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, TELEMETRY_VALIDATE_OPTIONS);
  if (flag(parsed, "help") || parsed.positionals.length === 0) {
    ctx.stdout(helpFor("telemetry validate", "<segment.ndjson>… [--instance-id …]", TELEMETRY_VALIDATE_OPTIONS));
    return parsed.positionals.length === 0 && !flag(parsed, "help") ? EXIT.usage : EXIT.ok;
  }
  const override = str(parsed, "instance-id");
  if (override !== undefined && parsed.positionals.length > 1) throw usage("--instance-id applies to one segment at a time");
  const out = new Output(ctx, flag(parsed, "json"));
  const verdicts: SegmentVerdict[] = [];
  for (const path of parsed.positionals) {
    let verdict: SegmentVerdict;
    try {
      verdict = validateSegmentFile(path, override);
    } catch (error) {
      verdict = { path, instanceId: override ?? null, bytes: 0, lines: 0, rows: 0, invalid: [{ line: 0, reason: `read:${(error as NodeJS.ErrnoException).code ?? "error"}` }], partialTail: false, oversize: false, ok: false };
    }
    verdicts.push(verdict);
    out.line(`${verdict.ok ? "ok  " : "FAIL"} ${path}: ${verdict.rows} row${verdict.rows === 1 ? "" : "s"} of ${verdict.lines} line${verdict.lines === 1 ? "" : "s"}, ${verdict.bytes} B${verdict.instanceId ? ` (writer ${verdict.instanceId})` : ""}${verdict.partialTail ? ", partial last line skipped (a crashed writer)" : ""}${verdict.oversize ? `, over the ${SEGMENT_MAX_BYTES}-byte cap` : ""}`);
    for (const problem of verdict.invalid) out.line(`       line ${problem.line}: ${problem.reason}${problem.reason === "segment_name" ? " (name it seg-<instanceId>-<epochMinute>-<n>.ndjson or pass --instance-id)" : ""}`);
  }
  const ok = verdicts.every((v) => v.ok);
  out.set("segments", verdicts);
  out.set("ok", ok);
  out.line(ok ? `${verdicts.length} segment${verdicts.length === 1 ? "" : "s"} fit the spool contract; the uploader would ship ${verdicts.reduce((n, v) => n + v.rows, 0)} rows` : `${verdicts.filter((v) => !v.ok).length} of ${verdicts.length} segment${verdicts.length === 1 ? "" : "s"} would be quarantined`);
  out.flush();
  return ok ? EXIT.ok : EXIT.refused;
}
