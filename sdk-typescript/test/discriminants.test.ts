/**
 * S1 (AIR-1969): identity is data, never the class.
 *
 * A lockfile can hold two copies of this package; an error thrown by one is
 * not `instanceof` the class from the other, and a sink built by one copy is
 * not `instanceof` the other's `MemorySink`. Every guard here must accept the
 * *foreign* shape — same `name`, same `code`, a different constructor — and
 * no source file may branch on `instanceof` of an SDK class. Two of
 * everything (test arity): a foreign copy and a near-miss for each guard.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentStartError, isAgentStartError } from "../src/agent.js";
import { ManagedRunError, isManagedRunError } from "../src/managed/client.js";
import { errorNamed } from "../src/protocol/errors.js";
import { DirectorySink, MemorySink, SpoolWriter, type SpoolRow, type SpoolSink } from "../src/spool/writer.js";
import { PayloadDecryptError, isPayloadDecryptError } from "../src/store/payloadCrypto.js";
import { StoreError, isStoreError } from "../src/store/slotStore.js";
import { DaemonError, isDaemonError } from "../src/sync/daemon.js";

/** What another copy of this package throws: a plain Error dressed with the same name and code. */
function foreign(name: string, fields: Record<string, unknown>): Error {
  return Object.assign(new Error("from another copy"), { name, ...fields });
}

test("every SDK error is recognised by name and code, including one thrown by another copy of the package", () => {
  const cases: Array<[string, (e: unknown) => boolean, Error, Error, Error]> = [
    ["StoreError", isStoreError, new StoreError("store_corrupt", "x"), foreign("StoreError", { code: "store_corrupt" }), foreign("StoreError", {})],
    ["DaemonError", isDaemonError, new DaemonError("absent", "x"), foreign("DaemonError", { code: "absent" }), foreign("DaemonErr", { code: "absent" })],
    ["AgentStartError", isAgentStartError, new AgentStartError("no_verified_release", "x"), foreign("AgentStartError", { code: "no_verified_release" }), foreign("AgentStartError", { code: 7 })],
    ["ManagedRunError", isManagedRunError, new ManagedRunError("forbidden", 403, "x", "d"), foreign("ManagedRunError", { code: "forbidden" }), foreign("StoreError", { code: "forbidden" })],
    ["PayloadDecryptError", isPayloadDecryptError, new PayloadDecryptError(), foreign("PayloadDecryptError", { code: "payload_decrypt_failed" }), foreign("PayloadDecryptError", {})],
  ];
  for (const [name, guard, own, copy, nearMiss] of cases) {
    assert.equal(guard(own), true, `${name}: our own instance`);
    assert.equal(guard(copy), true, `${name}: the foreign copy`);
    assert.equal(guard(nearMiss), false, `${name}: the near-miss`);
    assert.equal(guard(null), false, `${name}: null`);
    assert.equal(guard("StoreError"), false, `${name}: a string`);
  }
  assert.equal(errorNamed(foreign("X", { code: "c" }), "X"), true);
  assert.equal(errorNamed(new Error("x"), "Error"), false, "an Error without a code is not an SDK error");
});

test("a sink is what its kind and capabilities say, so a foreign or custom sink is drained and measured the same way", () => {
  assert.equal(new MemorySink({ instanceId: "i-1" }).kind, "memory");
  const dir = mkdtempSync(join(tmpdir(), "ap-sink-"));
  try {
    assert.equal(new DirectorySink(dir, "i-1").kind, "directory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const rows: SpoolRow[] = [];
  // Neither `instanceof MemorySink` nor `instanceof DirectorySink`: a custom sink that buffers and reports depth.
  const custom: SpoolSink = {
    kind: "custom-buffer",
    append: (row) => void rows.push(row),
    flush: () => undefined,
    drain: () => rows.splice(0),
    depth: () => ({ segments: 1, bytes: 2 }),
  };
  const writer = new SpoolWriter(custom, { instanceId: "i-1", instanceClass: "ephemeral", sdk: "test/0" });
  writer.refusal({ at: new Date().toISOString(), reason: "lease_expired", generation: 1, tag: null }, Date.now());
  writer.refusal({ at: new Date().toISOString(), reason: "lease_expired", generation: 2, tag: null }, Date.now());
  assert.equal(typeof custom.drain, "function");
  assert.equal(custom.drain!(Date.now()).length, 2, "the facade's capability check would drain both rows");
  assert.deepEqual(custom.depth?.(), { segments: 1, bytes: 2 });
});

/** The rule at source: nothing under src/ or cli/src branches on `instanceof <SDK class>`. */
test("no source file uses instanceof on an SDK class", () => {
  const sdkClasses = new Set<string>();
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) files.push(path);
    }
  };
  walk(join(process.cwd(), "src"));
  walk(join(process.cwd(), "..", "cli", "src"));
  for (const file of files) for (const m of readFileSync(file, "utf8").matchAll(/^export class (\w+)/gm)) sdkClasses.add(m[1]!);
  assert.ok(sdkClasses.has("StoreError") && sdkClasses.has("MemorySink") && sdkClasses.has("CliError"), "the class census found the SDK classes");
  const offenders: string[] = [];
  for (const file of files) {
    for (const [lineNo, line] of readFileSync(file, "utf8").split("\n").entries()) {
      const m = /\binstanceof\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (m && sdkClasses.has(m[1]!) && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//")) offenders.push(`${file.replace(process.cwd(), ".")}:${lineNo + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], "branch on `name` + `code` (errors) or `kind` / capabilities (sinks) instead");
});
