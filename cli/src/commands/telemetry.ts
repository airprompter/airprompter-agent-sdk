/**
 * `airprompter export-telemetry` / `import-telemetry` (T16, AIR-1946): the
 * spool over a file, for hosts that never call home.
 *
 *   export-telemetry   on the air-gapped host: pack every closed, unsent
 *                      segment in the store's spool into one `.aptelemetry`
 *                      document (the segments verbatim, base64url; the store's
 *                      active generation beside them) and move them to
 *                      `spool/telemetry/exported/` so the next export packs
 *                      only what is new (`--keep` leaves them in place).
 *   import-telemetry   on a connected host: open the document, heartbeat as
 *                      each instance it carries (the same heartbeat a runtime
 *                      sends, `syncMode: offline`, with an Agent key holding
 *                      `agent.telemetry.write`) for an upload grant to that
 *                      instance's prefix, validate every row, and POST each
 *                      segment through the grant. S3 PUT is idempotent by key
 *                      and ingest replaces rows per key, so importing the same
 *                      file twice changes nothing.
 *
 * Nothing here reads a row's content beyond validating its shape: a segment
 * is opaque bytes on the way through, exactly as the daemon treats it.
 *
 * @example
 * ```sh
 * # on the air-gapped host:
 * airprompter export-telemetry --org org_… --agent agt_… --environment prod --out 2026-09-12.aptelemetry
 * # on a host that reaches AirPrompter:
 * AIRPROMPTER_AGENT_KEY=… airprompter import-telemetry --org org_… --agent agt_… --environment prod --in 2026-09-12.aptelemetry
 * ```
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { SlotStore } from "../../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { SyncClient } from "../../../sdk-typescript/packages/core/src/control/client.js";
import { EXPORTED_CAP_BYTES, inspectSegment, postSegment, SEGMENT_NAME, type UploadGrant } from "../../../sdk-typescript/packages/telemetry/src/uploader.js";
import { PROTOCOL_VERSION } from "../../../sdk-typescript/packages/sdk/src/agent.js";
import { CLI_VERSION } from "../version.js";
import { COMMON_OPTIONS, SCOPE_OPTIONS, STORE_OPTIONS, defaultStateDir, flag, helpFor, openStore, parse, scopeOf, str, type OptionSpec } from "../args.js";
import { EXIT, Output, refused, usage, type Context } from "../io.js";

export const TELEMETRY_FILE_KIND = "airprompter-telemetry-export" as const;
/** Packed segments stay in `spool/telemetry/exported/` this long (a lost carrier can be re-exported with `--keep` from there); the next export sweeps older ones. */
export const EXPORTED_RETENTION_MS = 7 * 86_400_000;

export interface TelemetryExportFile {
  kind: typeof TELEMETRY_FILE_KIND;
  v: 1;
  protocol: string;
  organizationId: string;
  agentId: string;
  target: string;
  exportedAt: string;
  /** What the exporting store held, so the import's heartbeat reports the truth. */
  generation: number;
  cli: string;
  segments: Array<{ name: string; instanceId: string; bytes: string }>;
}

export const EXPORT_OPTIONS: OptionSpec = {
  ...SCOPE_OPTIONS,
  ...STORE_OPTIONS,
  out: { type: "string", help: "Where to write the .aptelemetry document" },
  keep: { type: "boolean", default: false, help: "Leave the packed segments in the spool (the next export packs them again)" },
  ...COMMON_OPTIONS,
};

export const IMPORT_OPTIONS: OptionSpec = {
  ...SCOPE_OPTIONS,
  in: { type: "string", help: "The .aptelemetry document an offline host exported" },
  "base-url": { type: "string", default: "https://api.airprompter.com", help: "API base URL" },
  "api-key-env": { type: "string", default: "AIRPROMPTER_AGENT_KEY", help: "Environment variable holding the Agent key (agent.telemetry.write)" },
  ...COMMON_OPTIONS,
};

function spoolDir(stateDir: string, scope: { agentId: string; target: "dev" | "staging" | "prod" }): string {
  return join(SlotStore.path({ stateDir, agentId: scope.agentId, target: scope.target }), "spool", "telemetry");
}

export async function exportTelemetry(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, EXPORT_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("export-telemetry", "--org … --agent … --environment … --out telemetry.aptelemetry [--state-dir …] [--keep]", EXPORT_OPTIONS));
    return EXIT.ok;
  }
  const out = new Output(ctx, flag(parsed, "json"));
  const scope = scopeOf(parsed);
  const target = str(parsed, "out");
  if (!target) throw usage("--out is required");
  const stateDir = str(parsed, "state-dir") ?? defaultStateDir(ctx);
  const dir = spoolDir(stateDir, scope);
  let generation = 0;
  try {
    const store = await openStore(parsed, ctx, scope);
    generation = store.state.generation ?? 0;
  } catch {
    // No store on this host (a spool written by another writer): the export still packs the segments; generation 0.
  }
  const segments: TelemetryExportFile["segments"] = [];
  const packed: string[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      const match = SEGMENT_NAME.exec(name);
      if (!match || name.endsWith(".open")) continue;
      const path = join(dir, name);
      if (!statSync(path).isFile()) continue;
      const bytes = readFileSync(path);
      const inspection = inspectSegment(bytes, match[1]!);
      if (inspection.rows.length === 0) {
        ctx.stderr(`${name}: no valid row (${inspection.invalid.length} refused) — left in place`);
        continue;
      }
      segments.push({ name, instanceId: match[1]!, bytes: bytes.toString("base64url") });
      packed.push(name);
    }
  }
  const now = new Date(ctx.now()).toISOString();
  const document: TelemetryExportFile = { kind: TELEMETRY_FILE_KIND, v: 1, protocol: PROTOCOL_VERSION, organizationId: scope.organizationId, agentId: scope.agentId, target: scope.target, exportedAt: now, generation, cli: CLI_VERSION, segments };
  mkdirSync(dirname(target) || ".", { recursive: true });
  writeFileSync(target, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  let swept = 0;
  if (!flag(parsed, "keep") && packed.length > 0) {
    const exported = join(dir, "exported");
    mkdirSync(exported, { recursive: true, mode: 0o700 });
    for (const name of packed) renameSync(join(dir, name), join(exported, name));
    // The bucket's copy is the record once imported; what was packed more than a week ago is swept here, the only
    // place that writes this directory (the SDK's budget never counts it, so it would otherwise grow without bound).
    for (const name of readdirSync(exported)) {
      const path = join(exported, name);
      if (SEGMENT_NAME.test(name) && statSync(path).mtimeMs < ctx.now() - EXPORTED_RETENTION_MS) {
        unlinkSync(path);
        swept += 1;
      }
    }
    // S6: exported/ is one term of the spool's disk invariant — held under its byte cap, oldest first, whatever its age.
    const kept = readdirSync(exported).filter((name) => SEGMENT_NAME.test(name)).sort();
    let total = kept.reduce((sum, name) => sum + statSync(join(exported, name)).size, 0);
    for (const name of kept) {
      if (total <= EXPORTED_CAP_BYTES) break;
      const size = statSync(join(exported, name)).size;
      unlinkSync(join(exported, name));
      total -= size;
      swept += 1;
    }
  }
  out.field("out", target);
  out.field("segments", segments.length);
  out.field("bytes", segments.reduce((sum, s) => sum + Buffer.from(s.bytes, "base64url").length, 0));
  out.field("instances", new Set(segments.map((s) => s.instanceId)).size);
  out.field("generation", generation);
  out.field("moved", flag(parsed, "keep") ? "kept in place" : packed.length > 0 ? `${packed.length} to spool/telemetry/exported/` : "nothing");
  out.set("swept", swept);
  out.flush();
  return EXIT.ok;
}

/** The heartbeat a connected host sends on an offline instance's behalf: the protocol's required keys, content-free. */
export function importHeartbeatBody(file: TelemetryExportFile, instanceId: string, segments: number, bytes: number): Record<string, unknown> {
  return {
    protocol: PROTOCOL_VERSION,
    instanceId,
    instanceClass: "resident",
    sdk: { name: "airprompter-cli", version: CLI_VERSION },
    syncMode: "offline",
    generation: { active: file.generation },
    applyState: "active",
    storageProtection: "file_key",
    catalog: { models: [], reportedAt: file.exportedAt },
    lease: { expired: false },
    spool: { depthSegments: segments, depthBytes: bytes, droppedSegments: 0, quarantinedSegments: 0 },
  };
}

export async function importTelemetry(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, IMPORT_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("import-telemetry", "--org … --agent … --environment … --in telemetry.aptelemetry [--base-url …]", IMPORT_OPTIONS));
    return EXIT.ok;
  }
  const out = new Output(ctx, flag(parsed, "json"));
  const scope = scopeOf(parsed);
  const path = str(parsed, "in");
  if (!path) throw usage("--in is required");
  if (!existsSync(path)) throw usage(`${path} not found`);
  const apiKeyEnv = str(parsed, "api-key-env") ?? "AIRPROMPTER_AGENT_KEY";
  const apiKey = ctx.env[apiKeyEnv];
  if (!apiKey) throw usage(`${apiKeyEnv} is not set (the Agent key is read from the environment, never from argv)`);
  if (!ctx.fetch) throw usage("no fetch available");
  const file = JSON.parse(readFileSync(path, "utf8")) as Partial<TelemetryExportFile>;
  if (file.kind !== TELEMETRY_FILE_KIND || file.v !== 1 || !Array.isArray(file.segments)) throw usage(`${path}: not a telemetry export`);
  if (file.agentId !== scope.agentId || file.target !== scope.target) throw usage(`${path} is for ${file.agentId}/${file.target}, not ${scope.agentId}/${scope.target}`);
  const document = file as TelemetryExportFile;
  const client = new SyncClient({ baseUrl: str(parsed, "base-url") ?? "https://api.airprompter.com", agentId: scope.agentId, target: scope.target, apiKey, fetch: ctx.fetch, userAgent: `airprompter-cli/${CLI_VERSION}` });

  const byInstance = new Map<string, TelemetryExportFile["segments"]>();
  for (const segment of document.segments) {
    if (!SEGMENT_NAME.test(segment.name)) throw refused(`${segment.name}: not a segment name`, { reason: "malformed" });
    byInstance.set(segment.instanceId, [...(byInstance.get(segment.instanceId) ?? []), segment]);
  }
  let uploaded = 0;
  let refusedCount = 0;
  let quarantined = 0;
  let held: number | null = null;
  const perInstance: Array<{ instanceId: string; segments: number; uploaded: number; grant: string | null }> = [];
  for (const [instanceId, segments] of byInstance) {
    const bytes = segments.reduce((sum, s) => sum + Buffer.from(s.bytes, "base64url").length, 0);
    const heartbeat = await client.heartbeat(importHeartbeatBody(document, instanceId, segments.length, bytes));
    if (heartbeat.status === "refused") throw refused(`heartbeat for ${instanceId} refused (HTTP ${heartbeat.httpStatus}${heartbeat.code ? `, ${heartbeat.code}` : ""})`, { reason: heartbeat.code ?? `http_${heartbeat.httpStatus}` });
    if (heartbeat.status === "error") throw refused(`heartbeat for ${instanceId} failed with HTTP ${heartbeat.httpStatus}`, { reason: `http_${heartbeat.httpStatus}` });
    const grant = heartbeat.response.uploadGrant as UploadGrant | undefined;
    if (!grant) {
      const retry = Number(heartbeat.response.retryAfterSeconds ?? 0);
      held = Math.max(held ?? 0, retry || 60);
      perInstance.push({ instanceId, segments: segments.length, uploaded: 0, grant: null });
      continue;
    }
    let count = 0;
    for (const segment of segments) {
      const raw = Buffer.from(segment.bytes, "base64url");
      const inspection = inspectSegment(raw, instanceId);
      if (inspection.rows.length === 0) {
        quarantined += 1;
        ctx.stderr(`${segment.name}: no valid row for ${instanceId} (${inspection.invalid.length} refused) — not uploaded`);
        continue;
      }
      const outcome = await postSegment({ grant, segment: segment.name, bytes: raw, fetch: ctx.fetch, now: ctx.now });
      if (outcome.status === "ok") {
        uploaded += 1;
        count += 1;
      } else {
        refusedCount += 1;
        ctx.stderr(`${segment.name}: ${outcome.status === "refused" ? `refused (HTTP ${outcome.httpStatus}${outcome.expired ? ", grant expired" : ""})` : outcome.status === "too_large" ? `too large (${outcome.bytes} bytes)` : `network: ${outcome.reason}`}`);
      }
    }
    perInstance.push({ instanceId, segments: segments.length, uploaded: count, grant: grant.grantId });
  }
  out.field("in", path);
  out.field("segments", document.segments.length);
  out.field("uploaded", uploaded);
  out.field("refused", refusedCount);
  out.field("quarantined", quarantined);
  out.set("instances", perInstance);
  out.line(`instances: ${perInstance.map((i) => `${i.instanceId} ${i.uploaded}/${i.segments}${i.grant ? "" : " (held)"}`).join(", ") || "none"}`);
  if (held !== null) out.field("retryAfterSeconds", held, "retry after");
  out.flush();
  if (held !== null) {
    ctx.stderr(`held: the platform asked to retry in ${held}s for ${perInstance.filter((i) => !i.grant).length} instance(s)`);
    return EXIT.refused;
  }
  return refusedCount > 0 || quarantined > 0 ? EXIT.refused : EXIT.ok;
}
