/**
 * Cross-language interop fixture: the TypeScript SDK writes a store (file
 * key, one promoted generation, an encrypted payload, a spool segment) into
 * the directory named by argv[2] and prints what the Python SDK must read
 * back from it. Run from sdk-typescript (where tsx is installed):
 *
 *   node --import tsx ../sdk-python/tests/interop/write_ts_store.mts <stateDir>
 */

import { join } from "node:path";

import { fileKey } from "../../../sdk-typescript/packages/sync/src/store/keyProvider.js";
import { SlotStore } from "../../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { DirectorySink, SpoolWriter } from "../../../sdk-typescript/packages/telemetry/src/spool/writer.js";
import { publicJwkOf } from "../../../sdk-typescript/packages/core/src/protocol/trust.js";
import { mintRunRef } from "../../../sdk-typescript/packages/core/src/render/runRef.js";
import { createHmac } from "node:crypto";
import { FakeControlPlane } from "../../../sdk-typescript/test/helpers/controlPlane.js";

const stateDir = process.argv[2];
if (!stateDir) throw new Error("usage: write_ts_store.mts <stateDir>");
const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };
const plane = new FakeControlPlane(scope);
const manifest = plane.promote([
  plane.slot({ tag: "support.triage", text: "Triage for {{team}}: {{ticket}}", variables: [{ name: "team", required: true, trust: "operator" }, { name: "ticket", required: true, trust: "end_user" }] }),
  plane.slot({ tag: "support.reply", text: "Reply politely to {{name}}.", variables: [{ name: "name", required: false, trust: "operator" }], model: "gpt-5" }),
]);
const store = await SlotStore.open({ stateDir, ...scope, keyProvider: fileKey(join(SlotStore.path({ stateDir, ...scope }), "store.key")) });
store.acceptRoot(plane.root);
store.stage({ manifest, payloads: plane.payloads });
store.activate();
const sink = new DirectorySink(join(store.dir, "spool", "telemetry"), store.instanceId);
const writer = new SpoolWriter(sink, { instanceId: store.instanceId, instanceClass: "resident", sdk: "agent-sdk-ts/0.1.0" });
const t0 = Date.parse("2026-09-12T14:03:10Z");
writer.observe({ tag: "support.triage", versionId: "ver_support.triage_1", arm: "none", model: "claude-sonnet-5", status: "ok", latencyMs: 812, tokens: { input: 400, output: 90, cachedInput: 100 } }, t0);
writer.closeWindows(t0 + 60_000);
const runRefKey = createHmac("sha256", Buffer.from(store.instanceId, "utf8")).update("runRef").digest();
const runRef = mintRunRef({ agentId: "agt_1", target: "prod", tag: "support.triage", versionId: "ver_support.triage_1", arm: "none", generation: 1, bucket: null }, runRefKey);
process.stdout.write(
  JSON.stringify({
    pinnedRoot: publicJwkOf(plane.rootKey),
    generation: manifest.payload.generation,
    releaseDigest: manifest.payload.releaseDigest,
    signingKeyId: manifest.signatures[0]!.keyId,
    instanceId: store.instanceId,
    texts: Object.fromEntries(manifest.payload.slots.map((slot) => [slot.tag, plane.payloads.get(slot.contentHash)!.toString("utf8")])),
    runRef,
  }),
);
