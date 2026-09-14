/**
 * `airprompter telemetry verify --budget <bytes> --sink-absent` (S6): the
 * customer's proof that the spool's disk budget is an invariant, run on
 * this machine against a filling in-memory filesystem with no registry
 * behind it. Two writers write past the budget, a third crashed mid-open
 * two hours ago, a fourth is live this minute, and a buggy third-party
 * writer has already overfilled quarantine/; one uploader pass then has
 * to leave the tree under
 *
 *   tree ≤ budget + (writers × 1 MiB open) + quarantine cap + exported cap
 *
 * and to say what it evicted in one `dropped` row with the right byte
 * count. The command prints the tree before and after, the eviction, the
 * `dropped` row, the bound and the verdict; exit 0 when the invariant holds.
 * Nothing here touches the host's real spool.
 */

import { join } from "node:path";

import { epochMinute, segmentName, SEGMENT_MAX_BYTES, type SpoolRow } from "../../../sdk-typescript/packages/telemetry/src/spool/writer.js";
import { EXPORTED_CAP_BYTES, QUARANTINE_CAP_BYTES, SEGMENT_NAME, SpoolUploader } from "../../../sdk-typescript/packages/telemetry/src/uploader.js";
import { MemoryFs } from "../../../sdk-typescript/packages/core/src/testing/memoryFs.js";
import { COMMON_OPTIONS, flag, helpFor, parse, str, type OptionSpec } from "../args.js";
import { CliError, EXIT, Output, type Context } from "../io.js";

export const TELEMETRY_VERIFY_OPTIONS: OptionSpec = {
  budget: { type: "string", help: "The closed-segment budget to verify, in bytes (the runtime's default is 104857600)" },
  "sink-absent": { type: "boolean", default: false, help: "No registry answers: no grant is ever issued, so nothing uploads and the budget alone must hold (the only mode today)" },
  writers: { type: "string", help: "How many live writers to simulate (default 2)" },
  "quarantine-cap": { type: "string", help: "The quarantine/ byte cap to verify (default 10485760)" },
  ...COMMON_OPTIONS,
};

const DIR = "/spool";

function windowRow(instanceId: string, minute: string): SpoolRow {
  return { type: "window", v: 1, minute, instanceId, instanceClass: "resident", tag: "verify.budget", versionId: "ver_verify", arm: "none", model: "verify", status: "ok", errorClass: null, usageSource: "unavailable", count: 1, latencyMs: { buckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0], sum: 812 }, tokens: { input: 0, output: 0 }, sdk: "airprompter-cli/verify" };
}

export async function telemetryVerify(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, TELEMETRY_VERIFY_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("telemetry verify", "--budget <bytes> --sink-absent [--writers N] [--quarantine-cap <bytes>]", TELEMETRY_VERIFY_OPTIONS));
    return EXIT.ok;
  }
  if (!flag(parsed, "sink-absent")) throw new CliError(EXIT.usage, "telemetry verify runs with --sink-absent (no registry) — that is the case the budget exists for");
  const budget = Number(str(parsed, "budget") ?? "");
  if (!Number.isInteger(budget) || budget < 1024) throw new CliError(EXIT.usage, "--budget must be a whole number of bytes, at least 1024");
  const writers = Number(str(parsed, "writers") ?? "2");
  if (!Number.isInteger(writers) || writers < 1 || writers > 64) throw new CliError(EXIT.usage, "--writers must be a whole number from 1 to 64");
  const quarantineCap = Number(str(parsed, "quarantine-cap") ?? String(QUARANTINE_CAP_BYTES));
  if (!Number.isInteger(quarantineCap) || quarantineCap < 1024) throw new CliError(EXIT.usage, "--quarantine-cap must be a whole number of bytes, at least 1024");
  const out = new Output(ctx, flag(parsed, "json"));

  const fs = new MemoryFs();
  const T0 = ctx.now();
  fs.clockMs = T0;
  fs.mkdirp(DIR, 0o700);
  const events: Record<string, unknown>[] = [];
  const uploader = new SpoolUploader({
    dir: DIR,
    instanceId: "i-verify00000000",
    grantFor: async () => ({ kind: "unavailable", reason: "sink_absent" }),
    fetch: async () => {
      throw new Error("sink absent");
    },
    fs,
    now: () => fs.clockMs,
    random: () => 0.5,
    logger: (event) => events.push(event),
    budgetBytes: budget,
    quarantineCapBytes: quarantineCap,
    exportedCapBytes: EXPORTED_CAP_BYTES,
  });
  // The writers fill the budget past its edge: one-row segments a minute apart until the closed set is 1.5× the budget.
  const ids = Array.from({ length: writers }, (_, i) => `i-writer${String(i).padStart(8, "0")}`);
  const written: Array<{ name: string; bytes: number }> = [];
  let minute = 0;
  let closedBytes = 0;
  while (closedBytes < budget * 1.5) {
    const writer = ids[minute % writers]!;
    const at = T0 + minute * 60_000;
    fs.clockMs = at;
    const name = segmentName(writer, epochMinute(at), 0);
    const bytes = Buffer.from(`${JSON.stringify(windowRow(writer, new Date(at).toISOString().slice(0, 17) + "00Z"))}\n`, "utf8");
    fs.writeFile(join(DIR, name), bytes, 0o600);
    written.push({ name, bytes: bytes.length });
    closedBytes += bytes.length;
    minute += 1;
    if (minute > 100_000) throw new CliError(EXIT.refused, "the budget is too large to fill in one pass; try a smaller --budget");
  }
  // A writer that crashed two hours ago left an .open file; a live writer holds one this minute; a stranger wrote nonsense.
  fs.clockMs = T0 - 2 * 60 * 60_000;
  const crashed = `${segmentName("i-crashed0000000", epochMinute(fs.clockMs), 0)}.open`;
  fs.writeFile(join(DIR, crashed), Buffer.from(`${JSON.stringify(windowRow("i-crashed0000000", new Date(fs.clockMs).toISOString().slice(0, 17) + "00Z"))}\n{"partial":`, "utf8"), 0o600);
  fs.clockMs = T0 + minute * 60_000;
  const live = `${segmentName(ids[0]!, epochMinute(fs.clockMs), 0)}.open`;
  fs.writeFile(join(DIR, live), Buffer.from(`${JSON.stringify(windowRow(ids[0]!, new Date(fs.clockMs).toISOString().slice(0, 17) + "00Z"))}\n`, "utf8"), 0o600);
  // A buggy third-party writer filled quarantine/ past its cap before this pass (inspection happens at upload time, so with
  // the sink absent nothing new is quarantined here; the cap is what bounds the directory whatever put things there).
  const quarantined: string[] = [];
  let quarantineBytes = 0;
  for (let i = 0; quarantineBytes < quarantineCap * 1.5; i += 1) {
    fs.clockMs = T0 - (1000 - i) * 60_000;
    const name = segmentName("i-stranger000000", epochMinute(fs.clockMs), 0);
    const bytes = Buffer.from(`${JSON.stringify({ ...windowRow("i-stranger000000", new Date(fs.clockMs).toISOString().slice(0, 17) + "00Z"), prompt: "not allowed here" })}\n`, "utf8");
    fs.writeFile(join(DIR, "quarantine", name), bytes, 0o600);
    quarantined.push(name);
    quarantineBytes += bytes.length;
    if (i > 100_000) throw new CliError(EXIT.refused, "the quarantine cap is too large to fill in one pass; try a smaller --quarantine-cap");
  }
  fs.clockMs = T0 + minute * 60_000;
  const before = uploader.tree();
  const beforeClosed = uploader.depth();

  const pass = await uploader.runOnce();
  const after = uploader.tree();
  const afterClosed = uploader.depth();
  const remaining = fs.list(DIR).filter((n) => SEGMENT_NAME.test(n));
  const droppedName = remaining.find((n) => n.startsWith("seg-i-verify00000000-"));
  const droppedRow = droppedName ? (JSON.parse(Buffer.from(fs.readFile(join(DIR, droppedName))).toString("utf8").trim()) as { type: string; segments: number; bytes: number; instanceId: string; at: string }) : null;
  const bound = uploader.bound(writers);
  const evictedNames = written.filter((w) => !remaining.includes(w.name)).map((w) => w.name);
  const crashedBytes = Buffer.byteLength(`${JSON.stringify(windowRow("i-crashed0000000", new Date(T0 - 2 * 60 * 60_000).toISOString().slice(0, 17) + "00Z"))}\n{"partial":`);
  const crashedEvicted = !fs.exists(join(DIR, crashed)) && !remaining.includes(crashed.slice(0, -".open".length));
  const evictedBytes = written.filter((w) => !remaining.includes(w.name)).reduce((sum, w) => sum + w.bytes, 0) + (crashedEvicted ? crashedBytes : 0);
  const quarantineKept = fs.list(join(DIR, "quarantine")).sort();
  const oldestFirst = evictedNames.every((name, i) => i === 0 || SEGMENT_NAME.exec(name)![2]! >= SEGMENT_NAME.exec(evictedNames[i - 1]!)![2]!);
  const checks = {
    closedWithinBudget: afterClosed.bytes <= budget,
    treeWithinBound: after.totalBytes <= bound,
    droppedRowSaysTheBytes: droppedRow !== null && droppedRow.type === "dropped" && droppedRow.segments === pass.dropped && droppedRow.bytes === evictedBytes,
    oldestEvictedFirst: oldestFirst,
    abandonedOpenReclaimed: !fs.exists(join(DIR, crashed)) && uploader.status().reclaimedSegments === 1,
    liveOpenUntouched: fs.exists(join(DIR, live)),
    quarantineWithinCap: after.quarantineBytes <= quarantineCap && quarantineKept.length > 0 && quarantineKept.length < quarantined.length,
    quarantineOldestEvictedFirst: quarantineKept.every((name) => quarantined.indexOf(name) >= quarantined.length - quarantineKept.length),
    nothingUploaded: pass.held && pass.uploaded.length === 0,
  };
  const holds = Object.values(checks).every(Boolean);

  out.field("budgetBytes", budget, "budget");
  out.field("writers", writers);
  out.field("quarantineCapBytes", quarantineCap, "quarantine cap");
  out.field("exportedCapBytes", EXPORTED_CAP_BYTES, "exported cap");
  out.field("boundBytes", bound, "bound (budget + writers × 1 MiB + caps)");
  out.set("before", { closedSegments: beforeClosed.segments, closedBytes: beforeClosed.bytes, ...before });
  out.set("after", { closedSegments: afterClosed.segments, closedBytes: afterClosed.bytes, ...after });
  out.set("evicted", { segments: pass.dropped, names: evictedNames, bytes: evictedBytes });
  out.set("droppedRow", droppedRow);
  out.set("checks", checks);
  out.set("holds", holds);
  out.set("events", events.filter((e) => e.event !== "fs_fault").map((e) => e.event));
  out.line(`before: ${beforeClosed.segments} closed segments (${beforeClosed.bytes} B) + ${before.openSegments} open (${before.openBytes} B) + quarantine ${before.quarantineBytes} B + exported ${before.exportedBytes} B = ${before.totalBytes} B`);
  out.line(`sink absent: no grant, nothing uploaded, the budget alone holds`);
  out.line(`evicted: ${pass.dropped} oldest unsent segment${pass.dropped === 1 ? "" : "s"} (${evictedBytes} B)${uploader.status().reclaimedSegments ? `, the abandoned .open from two hours ago reclaimed first` : ""}; quarantine/ held to its cap (${quarantined.length - quarantineKept.length} of ${quarantined.length} oldest files evicted)`);
  out.line(droppedRow ? `dropped row: ${JSON.stringify(droppedRow)}` : "dropped row: none written");
  out.line(`after: ${afterClosed.segments} closed segments (${afterClosed.bytes} B) + ${after.openSegments} open (${after.openBytes} B) + quarantine ${after.quarantineBytes} B + exported ${after.exportedBytes} B = ${after.totalBytes} B`);
  out.line(`invariant: tree ${after.totalBytes} B ≤ ${bound} B (budget ${budget} + ${writers} × ${SEGMENT_MAX_BYTES} open + quarantine cap ${quarantineCap} + exported cap ${EXPORTED_CAP_BYTES}) — ${holds ? "holds" : "VIOLATED"}`);
  for (const [name, ok] of Object.entries(checks)) out.line(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  out.flush();
  return holds ? EXIT.ok : EXIT.refused;
}
