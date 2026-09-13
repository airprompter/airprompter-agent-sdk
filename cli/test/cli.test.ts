/**
 * The CLI as a function, against the SDK's fake control plane: keygen →
 * pull (encrypted) → verify → apply on a clean host → status → diff →
 * apply the next generation → pull --check; every refusal with its exit
 * code and reason; and the rule that no output ever carries payload text.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AirPrompterAgent } from "../../sdk-typescript/src/agent.js";
import { publicJwkOf } from "../../sdk-typescript/src/protocol/trust.js";
import type { Bundle } from "../../sdk-typescript/src/protocol/types.js";
import { FakeControlPlane, newKey, rootDocument } from "../../sdk-typescript/test/helpers/controlPlane.js";
import { run } from "../src/cli.js";
import { EXIT, type Context } from "../src/io.js";

const scope = { organizationId: "org_1", agentId: "agt_1", target: "prod" as const };
const PROMPT_TEXT = "You are a triage assistant for {{team}}. Ticket: {{ticket}}";

interface Harness {
  ctx: Context;
  stdout: string[];
  stderr: string[];
  json: () => Record<string, unknown>;
  all: () => string;
  reset: () => void;
}

function harness(plane: FakeControlPlane | null, work: string, env: Record<string, string> = {}): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    ctx: { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l), env: { HOME: work, AIRPROMPTER_AGENT_KEY: plane?.apiKey ?? "", ...env }, cwd: work, now: () => Date.now(), fetch: plane ? plane.fetch() : null, isTTY: false },
    stdout,
    stderr,
    json: () => JSON.parse(stdout[stdout.length - 1]!) as Record<string, unknown>,
    all: () => [...stdout, ...stderr].join("\n"),
    reset: () => {
      stdout.length = 0;
      stderr.length = 0;
    },
  };
}

const scopeArgs = ["--org", scope.organizationId, "--agent", scope.agentId, "--environment", scope.target];

function setup() {
  const work = mkdtempSync(join(tmpdir(), "ap-cli-"));
  const plane = new FakeControlPlane(scope);
  const rootPath = join(work, "root.jwk.json");
  writeFileSync(rootPath, JSON.stringify(publicJwkOf(plane.rootKey)));
  const rootDocPath = join(work, "root.json");
  writeFileSync(rootDocPath, JSON.stringify(plane.root));
  return { work, plane, rootPath, rootDocPath, stateDir: join(work, "state") };
}

test("keygen → pull (encrypted) → verify → apply on a clean host → status → runtime serves it; nothing printed is payload text", async () => {
  const { work, plane, rootPath, rootDocPath, stateDir } = setup();
  const triage = plane.slot({ tag: "support.triage", text: PROMPT_TEXT, variables: [{ name: "team", required: true, trust: "operator" }, { name: "ticket", required: true, trust: "end_user" }] });
  plane.promote([triage]);
  const h = harness(plane, work);

  assert.equal(await run(["keygen", "--purpose", "distribution", "--out", join(work, "keys", "prod"), "--json"], h.ctx), EXIT.ok);
  const keygen = h.json();
  if (process.platform !== "win32") assert.equal(statSync(join(work, "keys", "prod.key.json")).mode & 0o777, 0o600);
  h.reset();

  const bundlePath = join(work, "airprompter.bundle.apbundle");
  // A pinned key alone cannot name signing keys: pull needs a root document or --root-url.
  assert.equal(await run(["pull", ...scopeArgs, "--root", rootPath, "--distribution-key", join(work, "keys", "prod.pub.json"), "--out", bundlePath, "--json"], h.ctx), EXIT.refused);
  assert.equal(h.json().reason, "root_document_required");
  h.reset();
  // With --root-url the fetched root.json is verified against the pinned key.
  assert.equal(await run(["pull", ...scopeArgs, "--root", rootPath, "--root-url", "https://edge.test/roots/prod/root.json", "--distribution-key", join(work, "keys", "prod.pub.json"), "--out", bundlePath, "--json"], h.ctx), EXIT.ok);
  const pulled = h.json();
  assert.equal(pulled.generation, 1);
  assert.equal(Math.round((Date.parse(String(pulled.notAfter)) - h.ctx.now()) / 86_400_000), 90, "the platform's update-file default");
  assert.equal(pulled.encryption, "hpke");
  assert.equal(pulled.recipientKeyId, keygen.keyId);
  assert.equal(pulled.slots, 1);
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as Bundle;
  assert.equal(bundle.encryption.scheme, "hpke-x25519-hkdf-sha256-aes-256-gcm");
  assert.equal(readFileSync(bundlePath, "utf8").includes("triage assistant"), false, "the bundle on disk is ciphertext");
  const meta = JSON.parse(readFileSync(`${bundlePath}.meta.json`, "utf8")) as Record<string, unknown>;
  assert.equal(meta.generation, 1);
  assert.equal(meta.kind, "airprompter-bundle-meta");
  assert.equal(JSON.stringify(meta).includes("triage"), false);
  h.reset();

  // verify: with the private key, the chain passes; without it, the bundle cannot be opened; with another key, wrong_recipient.
  assert.equal(await run(["verify", bundlePath, ...scopeArgs, "--root", rootDocPath, "--distribution-key", join(work, "keys", "prod.key.json"), "--json"], h.ctx), EXIT.ok);
  const verified = h.json();
  assert.equal(verified.ok, true);
  assert.equal(verified.step, "complete");
  assert.ok(verified.daysLeft === 89 || verified.daysLeft === 90, `daysLeft ${verified.daysLeft}`);
  assert.equal(verified.expiringSoon, false, "90 days out: no warning");
  h.reset();
  // T16: a bundle inside the platform's 30-day warning says how long it has left; more than a year is refused.
  const shortLived = join(work, "short.apbundle");
  assert.equal(await run(["pull", ...scopeArgs, "--root", rootDocPath, "--distribution-key", join(work, "keys", "prod.pub.json"), "--out", shortLived, "--not-after-days", "7", "--json"], h.ctx), EXIT.ok);
  h.reset();
  assert.equal(await run(["verify", shortLived, ...scopeArgs, "--root", rootDocPath, "--distribution-key", join(work, "keys", "prod.key.json"), "--json"], h.ctx), EXIT.ok);
  assert.ok(h.json().daysLeft === 6 || h.json().daysLeft === 7, `daysLeft ${h.json().daysLeft}`);
  assert.equal(h.json().expiringSoon, true);
  h.reset();
  assert.equal(await run(["verify", shortLived, ...scopeArgs, "--root", rootDocPath, "--distribution-key", join(work, "keys", "prod.key.json")], h.ctx), EXIT.ok);
  assert.ok(h.stdout.some((l) => /^warning: expires in [67] days — download a fresh update file before then$/.test(l)), h.stdout.join("\n"));
  h.reset();
  assert.equal(await run(["pull", ...scopeArgs, "--root", rootDocPath, "--distribution-key", join(work, "keys", "prod.pub.json"), "--out", shortLived, "--not-after-days", "400", "--json"], h.ctx), EXIT.usage);
  assert.equal((verified.manifest as { payloads: number }).payloads, 1);
  h.reset();
  assert.equal(await run(["verify", bundlePath, ...scopeArgs, "--root", rootDocPath, "--json"], h.ctx), EXIT.refused);
  assert.equal(h.json().reason, "wrong_recipient");
  h.reset();
  assert.equal(await run(["keygen", "--purpose", "distribution", "--out", join(work, "keys", "other")], h.ctx), EXIT.ok);
  h.reset();
  assert.equal(await run(["verify", bundlePath, ...scopeArgs, "--root", rootDocPath, "--distribution-key", join(work, "keys", "other.key.json"), "--json"], h.ctx), EXIT.refused);
  assert.equal(h.json().reason, "wrong_recipient");
  h.reset();
  // A pinned key works for verify too: the bundle's key-set is verified against it.
  assert.equal(await run(["verify", bundlePath, ...scopeArgs, "--root", rootPath, "--distribution-key", join(work, "keys", "prod.key.json")], h.ctx), EXIT.ok);
  assert.ok(h.stdout.some((l) => l.startsWith("root: pinned_key, accepted")));
  h.reset();

  // apply on a clean host: auto policy activates.
  assert.equal(await run(["apply", bundlePath, ...scopeArgs, "--root", rootPath, "--distribution-key", join(work, "keys", "prod.key.json"), "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
  const applied = h.json();
  assert.equal(applied.outcome, "activated");
  assert.equal(applied.generation, 1);
  assert.equal(applied.slot, "A");
  h.reset();
  // Applying the same generation again is a no-op.
  assert.equal(await run(["apply", bundlePath, ...scopeArgs, "--root", rootPath, "--distribution-key", join(work, "keys", "prod.key.json"), "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
  assert.equal(h.json().outcome, "unchanged");
  h.reset();

  assert.equal(await run(["status", "--agent", scope.agentId, "--environment", scope.target, "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
  const status = h.json();
  assert.equal(status.generation, 1);
  assert.equal(status.activeSlot, "A");
  assert.equal(status.storageProtection, "file_key");
  assert.equal((status.active as { verified: boolean }).verified, true);
  assert.deepEqual(status.spool, { segments: 0, bytes: 0, openSegments: 0 });
  h.reset();
  assert.equal(await run(["verify", stateDir, ...scopeArgs, "--root", rootPath, "--json"], h.ctx), EXIT.ok);
  assert.equal(h.json().ok, true);
  h.reset();

  // The runtime starts offline from what the CLI applied.
  const ap = await AirPrompterAgent.start({ ...scope, stateDir, root: { pinned: publicJwkOf(plane.rootKey) } });
  assert.equal(ap.generation, 1);
  assert.equal(ap.prompt("support.triage").render({ team: "Billing", ticket: "x" }).text, "You are a triage assistant for Billing. Ticket: <ticket>x</ticket>");
  await ap.stop();

  assert.equal(h.all().includes("triage assistant"), false, "no command output carries prompt text");
  rmSync(work, { recursive: true, force: true });
});

test("diff names what changes, apply moves the store forward, pull --check reports how far behind a build is with the exit contract", async () => {
  const { work, plane, rootPath, rootDocPath, stateDir } = setup();
  const triage = plane.slot({ tag: "support.triage", text: PROMPT_TEXT, variables: [{ name: "team", required: true, trust: "operator" }] });
  const reply = plane.slot({ tag: "support.reply", text: "Reply to {{name}}", variables: [{ name: "name", required: false, trust: "operator" }] });
  plane.promote([triage, reply]);
  const h = harness(plane, work);
  const keys = ["--distribution-key", join(work, "keys", "prod.pub.json")];
  const priv = ["--distribution-key", join(work, "keys", "prod.key.json")];
  await run(["keygen", "--purpose", "distribution", "--out", join(work, "keys", "prod")], h.ctx);
  const b1 = join(work, "b1.apbundle");
  assert.equal(await run(["pull", ...scopeArgs, "--root", rootDocPath, ...keys, "--out", b1], h.ctx), EXIT.ok);
  h.reset();
  assert.equal(await run(["diff", b1, ...scopeArgs, ...priv, "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
  assert.equal(h.json().from, null);
  assert.equal((h.json().slots as unknown[]).length, 2);
  h.reset();
  assert.equal(await run(["apply", b1, ...scopeArgs, "--root", rootPath, ...priv, "--state-dir", stateDir], h.ctx), EXIT.ok);
  h.reset();

  // Generation 2: reply changes model + version, triage gains a variable, a workflow appears, policy tightens.
  const reply2 = plane.slot({ tag: "support.reply", text: "Reply warmly to {{name}}", versionId: "ver_reply_2", model: "gpt-5", variables: [{ name: "name", required: true, trust: "operator" }] });
  const triage2 = { ...triage, variables: [...triage.variables, { name: "ticket", required: true, trust: "end_user" as const }] };
  const flow = plane.slot({ tag: "docs.flow", text: "flow", steps: [{ text: "one" }, { text: "two" }] });
  plane.promote([triage2, reply2, flow], { applyPolicy: "unlock_required", leaseSeconds: 900 });
  const b2 = join(work, "b2.apbundle");
  assert.equal(await run(["pull", ...scopeArgs, "--root", rootDocPath, ...keys, "--out", b2], h.ctx), EXIT.ok);
  h.reset();
  assert.equal(await run(["diff", b2, ...scopeArgs, ...priv, "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
  const diff = h.json();
  assert.deepEqual(diff.from, { generation: 1, releaseDigest: plane.manifest!.payload.previousReleaseDigest ?? (diff.from as { releaseDigest: string }).releaseDigest });
  const slots = diff.slots as Array<{ tag: string; change: string; fields?: string[] }>;
  assert.deepEqual(slots.map((s) => [s.tag, s.change]), [["docs.flow", "added"], ["support.reply", "changed"], ["support.triage", "changed"]]);
  assert.deepEqual(slots[1]!.fields, ["versionId", "model", "contentHash", "byteLength", "variables"]);
  assert.deepEqual(slots[2]!.fields, ["variables"]);
  const release = diff.release as Record<string, { from: unknown; to: unknown }>;
  assert.deepEqual(release.applyPolicy, { from: "auto", to: "unlock_required" });
  assert.deepEqual(release.leaseSeconds, { from: 3600, to: 900 });
  assert.equal(h.all().includes("Reply warmly"), false);
  h.reset();
  assert.equal(await run(["diff", b2, ...scopeArgs, ...priv, "--state-dir", stateDir], h.ctx), EXIT.ok);
  assert.ok(h.stdout.some((l) => l.includes("~ support.reply") && l.includes("model claude-sonnet-5 → gpt-5") && l.includes("variables name?:operator → name:operator")));
  assert.ok(h.stdout.some((l) => l.includes("+ docs.flow") && l.includes("2 steps")));
  h.reset();

  // pull --check: the vendored b1 is one generation behind.
  assert.equal(await run(["pull", ...scopeArgs, "--check", "--out", b1, "--json"], h.ctx), EXIT.stale);
  assert.deepEqual({ ...h.json() }, { vendoredGeneration: 1, currentGeneration: 2, behind: 1, maxBehind: 0, sameRelease: false, stale: true });
  h.reset();
  assert.equal(await run(["pull", ...scopeArgs, "--check", "--out", b1, "--max-behind", "2"], h.ctx), EXIT.ok);
  h.reset();
  assert.equal(await run(["pull", ...scopeArgs, "--check", "--out", b2], h.ctx), EXIT.ok);
  h.reset();
  assert.equal(await run(["pull", ...scopeArgs, "--check", "--out", join(work, "never-pulled.apbundle")], h.ctx), EXIT.usage);
  h.reset();

  // apply under unlock_required stages; the runtime reports it as awaiting unlock.
  assert.equal(await run(["apply", b2, ...scopeArgs, "--root", rootPath, ...priv, "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
  assert.equal(h.json().outcome, "staged");
  assert.equal(h.json().generation, 2);
  h.reset();
  assert.equal(await run(["status", "--agent", scope.agentId, "--environment", scope.target, "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
  assert.equal(h.json().generation, 1);
  assert.equal(h.json().stagedSlot, "B");
  h.reset();
  const ap = await AirPrompterAgent.start({ ...scope, stateDir, root: { pinned: publicJwkOf(plane.rootKey) } });
  assert.equal(ap.status().applyState, "awaiting_unlock");
  assert.equal(ap.status().stagedGeneration, 2);
  await ap.stop();
  // Applying generation 1 again now is a rollback: refused without --force, stamped with it.
  assert.equal(await run(["apply", b1, ...scopeArgs, "--root", rootPath, ...priv, "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok, "generation 1 is still the active generation: unchanged");
  assert.equal(h.json().outcome, "unchanged");
  h.reset();
  rmSync(work, { recursive: true, force: true });
});

test("refusals: a tampered payload, a foreign signing key, another target, plaintext outside dev, a rollback without --force", async () => {
  const { work, plane, rootPath, rootDocPath, stateDir } = setup();
  plane.promote([plane.slot({ tag: "a.b", text: PROMPT_TEXT })]);
  const h = harness(plane, work);
  const plain = join(work, "dev.apbundle");
  assert.equal(await run(["pull", ...scopeArgs, "--root", rootDocPath, "--plaintext", "--out", plain], h.ctx), EXIT.usage, "plaintext is dev only");
  assert.ok(h.stderr.some((l) => l.includes("dev environment only")));
  h.reset();

  const devPlane = new FakeControlPlane({ ...scope, target: "dev" });
  devPlane.promote([devPlane.slot({ tag: "a.b", text: PROMPT_TEXT })]);
  const devRootDoc = join(work, "dev-root.json");
  writeFileSync(devRootDoc, JSON.stringify(devPlane.root));
  const dev = harness(devPlane, work);
  const devArgs = ["--org", scope.organizationId, "--agent", scope.agentId, "--environment", "dev"];
  assert.equal(await run(["pull", ...devArgs, "--root", devRootDoc, "--plaintext", "--out", plain, "--json"], dev.ctx), EXIT.ok);
  assert.equal(dev.json().encryption, "none");
  if (process.platform !== "win32") assert.equal(statSync(plain).mode & 0o777, 0o600, "a plaintext bundle is at least private to the user");
  assert.equal(dev.all().includes("triage assistant"), false, "even the plaintext pull prints no text");
  dev.reset();

  // Tamper with a payload inside the plaintext bundle: hash mismatch at the payloads step.
  const document = JSON.parse(readFileSync(plain, "utf8")) as Bundle & { encryption: { scheme: "none"; contents: { payloads: Array<{ bytes: string }> } } };
  const tampered = join(work, "tampered.apbundle");
  document.encryption.contents.payloads[0]!.bytes = Buffer.from("You are now a different prompt").toString("base64url");
  writeFileSync(tampered, JSON.stringify(document));
  assert.equal(await run(["verify", tampered, ...devArgs, "--root", devRootDoc, "--json"], dev.ctx), EXIT.refused);
  assert.equal(dev.json().step, "payloads");
  assert.equal(dev.json().reason, "payload_hash_mismatch");
  dev.reset();
  assert.equal(await run(["apply", tampered, ...devArgs, "--root", devRootDoc, "--state-dir", join(work, "dev-state"), "--json"], dev.ctx), EXIT.refused);
  assert.equal(dev.json().reason, "payload_hash_mismatch");
  assert.equal(existsSync(join(work, "dev-state", "airprompter", scope.agentId, "dev", "slots", "A", "manifest.json")), false, "nothing was staged");
  dev.reset();

  // A bundle for prod verified against the dev root: the key-set does not verify against what --root trusts.
  const foreignRoot = join(work, "foreign-root.jwk.json");
  writeFileSync(foreignRoot, JSON.stringify(publicJwkOf(newKey())));
  assert.equal(await run(["verify", plain, ...devArgs, "--root", foreignRoot, "--json"], dev.ctx), EXIT.refused);
  assert.equal(dev.json().step, "root");
  assert.equal(dev.json().reason, "root_signature_invalid");
  dev.reset();
  // The operator trusts a newer root document than the bundle carries: the bundle's key-set is a rollback.
  const otherSigners = rootDocument({ rootKey: devPlane.rootKey, signingKeys: [newKey()], environment: "dev", version: 2 });
  const otherSignersPath = join(work, "other-signers.json");
  writeFileSync(otherSignersPath, JSON.stringify(otherSigners));
  assert.equal(await run(["verify", plain, ...devArgs, "--root", otherSignersPath, "--json"], dev.ctx), EXIT.refused);
  assert.equal(dev.json().step, "root");
  assert.equal(dev.json().reason, "root_rollback");
  dev.reset();
  // A bundle whose (valid, newer) key-set names other signing keys: the root is accepted, the manifest's signer is unknown.
  const devRootJwk = join(work, "dev-root.jwk.json");
  writeFileSync(devRootJwk, JSON.stringify(publicJwkOf(devPlane.rootKey)));
  const reKeyed = JSON.parse(readFileSync(plain, "utf8")) as Bundle & { encryption: { scheme: "none"; contents: { keySet: unknown } } };
  reKeyed.encryption.contents.keySet = otherSigners;
  const reKeyedPath = join(work, "rekeyed.apbundle");
  writeFileSync(reKeyedPath, JSON.stringify(reKeyed));
  assert.equal(await run(["verify", reKeyedPath, ...devArgs, "--root", devRootJwk, "--json"], dev.ctx), EXIT.refused);
  assert.equal(dev.json().step, "manifest");
  assert.equal(dev.json().reason, "unknown_signing_key");
  assert.equal((dev.json().root as { accepted: boolean; version: number }).accepted, true);
  dev.reset();
  // Another target: relabelled.
  assert.equal(await run(["verify", plain, ...scopeArgs, "--root", rootPath, "--json"], h.ctx), EXIT.refused);
  assert.equal(h.json().reason, "relabelled");
  h.reset();

  // Rollback on the dev host: apply generation 2, then generation 1 again is refused without --force and stamped with it.
  assert.equal(await run(["apply", plain, ...devArgs, "--root", devRootDoc, "--state-dir", join(work, "dev-state")], dev.ctx), EXIT.ok);
  devPlane.promote([devPlane.slot({ tag: "a.b", text: "second" })]);
  const plain2 = join(work, "dev2.apbundle");
  assert.equal(await run(["pull", ...devArgs, "--root", devRootDoc, "--plaintext", "--out", plain2], dev.ctx), EXIT.ok);
  assert.equal(await run(["apply", plain2, ...devArgs, "--root", devRootDoc, "--state-dir", join(work, "dev-state")], dev.ctx), EXIT.ok);
  dev.reset();
  assert.equal(await run(["apply", plain, ...devArgs, "--root", devRootDoc, "--state-dir", join(work, "dev-state"), "--json"], dev.ctx), EXIT.refused);
  assert.equal(dev.json().reason, "generation_rollback");
  dev.reset();
  assert.equal(await run(["apply", plain, ...devArgs, "--root", devRootDoc, "--state-dir", join(work, "dev-state"), "--force", "--json"], dev.ctx), EXIT.ok);
  assert.equal(dev.json().forcedDowngrade, true);
  assert.equal(dev.json().generation, 1);
  dev.reset();
  assert.equal(await run(["status", "--agent", scope.agentId, "--environment", "dev", "--state-dir", join(work, "dev-state"), "--json"], dev.ctx), EXIT.ok);
  assert.equal(dev.json().forcedDowngrade, true);
  assert.equal(dev.json().generation, 1);
  void stateDir;
  rmSync(work, { recursive: true, force: true });
});

test("usage errors exit 2 with the option named; --json carries the error; the Agent key is never read from argv", async () => {
  const work = mkdtempSync(join(tmpdir(), "ap-cli-"));
  const h = harness(null, work, { AIRPROMPTER_AGENT_KEY: "" });
  assert.equal(await run(["pull", "--agent", "agt_1", "--environment", "prod", "--out", "x"], h.ctx), EXIT.usage);
  assert.ok(h.stderr[0]!.includes("--org is required"));
  h.reset();
  assert.equal(await run(["pull", "--org", "o", "--agent", "agt_1", "--environment", "prod", "--out", "x", "--json"], h.ctx), EXIT.usage);
  assert.equal(h.json().exitCode, 2);
  assert.ok(String(h.json().error).includes("AIRPROMPTER_AGENT_KEY"));
  h.reset();
  assert.equal(await run(["pull", "--org", "o", "--agent", "agt_1", "--environment", "prod", "--api-key", "apa_live_x", "--out", "x"], h.ctx), EXIT.usage, "there is no --api-key option");
  h.reset();
  assert.equal(await run(["verify", "--org", "o", "--agent", "a", "--environment", "qa", "--root", "r", join(work, "nope")], h.ctx), EXIT.usage);
  assert.ok(h.stderr[0]!.includes("dev, staging or prod"));
  h.reset();
  assert.equal(await run(["keygen", "--purpose", "signing", "--out", join(work, "k")], h.ctx), EXIT.usage);
  h.reset();
  assert.equal(await run(["status", "--agent", "agt_1", "--environment", "prod", "--state-dir", join(work, "s"), "--help"], h.ctx), EXIT.ok);
  assert.ok(h.stdout[0]!.startsWith("Usage: airprompter status"));
  rmSync(work, { recursive: true, force: true });
});

test("pull --tags-only writes the hosted catalogue with a run key: tags, variables, step ids, arms — no payload bytes, no root needed; refusals keep their exit codes", async () => {
  const { work, plane } = setup();
  const h = harness(plane, work);
  const out = join(work, "airprompter.slots.json");
  assert.equal(await run(["pull", ...scopeArgs, "--tags-only", "--base-url", "https://run.test", "--out", out, "--json"], h.ctx), EXIT.refused, "nothing promoted yet");
  assert.equal(h.json().reason, "nothing_promoted");
  h.reset();
  plane.promote([plane.slot({ tag: "support.triage", text: PROMPT_TEXT, variables: [{ name: "team", required: true, trust: "operator" }, { name: "ticket", required: true, trust: "end_user" }] })]);
  assert.equal(await run(["pull", ...scopeArgs, "--tags-only", "--base-url", "https://run.test", "--out", out, "--json"], h.ctx), EXIT.ok, h.all());
  const printed = h.json();
  assert.equal(printed.generation, 1);
  assert.deepEqual(printed.slots, ["support.triage (prompt, 2 vars)"]);
  const written = JSON.parse(readFileSync(out, "utf8")) as { kind: string; slots: Array<{ tag: string; variables: unknown[] }>; experiment: unknown };
  assert.equal(written.kind, "airprompter-hosted-catalogue");
  assert.deepEqual(written.slots.map((s) => s.tag), ["support.triage"]);
  assert.equal(readFileSync(out, "utf8").includes("triage assistant"), false, "no payload text in the catalogue");
  assert.ok(plane.requests.every((u) => u.includes("/slots")), "only the catalogue was asked for");
  h.reset();
  const bad = harness(plane, work, { AIRPROMPTER_AGENT_KEY: "apr_wrong" });
  assert.equal(await run(["pull", ...scopeArgs, "--tags-only", "--base-url", "https://run.test", "--out", out, "--json"], bad.ctx), EXIT.refused);
  assert.equal(bad.json().reason, "unauthorized");
});

test("S4: the apply policy is the host's — apply pins on first use, a later update file may tighten and never loosen, `policy set` is the operator's act, status says which", async () => {
  const { work, plane, rootPath, rootDocPath, stateDir } = setup();
  const reply = plane.slot({ tag: "support.reply", text: "Reply to {{name}}", variables: [{ name: "name", required: false, trust: "operator" }] });
  plane.promote([reply], { applyPolicy: "auto" });
  const h = harness(plane, work);
  const keys = ["--distribution-key", join(work, "keys", "prod.pub.json")];
  const priv = ["--distribution-key", join(work, "keys", "prod.key.json")];
  const store = ["--agent", scope.agentId, "--environment", scope.target, "--state-dir", stateDir];
  await run(["keygen", "--purpose", "distribution", "--out", join(work, "keys", "prod")], h.ctx);
  const b1 = join(work, "b1.apbundle");
  assert.equal(await run(["pull", ...scopeArgs, "--root", rootDocPath, ...keys, "--out", b1], h.ctx), EXIT.ok);
  h.reset();
  // Nothing applied yet: nothing pinned.
  assert.equal(await run(["policy", "show", ...store, "--json"], h.ctx), EXIT.ok);
  assert.equal(h.json().applyPolicy, null);
  h.reset();
  assert.equal(await run(["apply", b1, ...scopeArgs, "--root", rootPath, ...priv, "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
  assert.deepEqual({ outcome: h.json().outcome, policy: h.json().policy, said: h.json().policySaid }, { outcome: "activated", policy: "auto", said: "auto" });
  h.reset();
  assert.equal(await run(["policy", "show", ...store, "--json"], h.ctx), EXIT.ok);
  const pinned = h.json().applyPolicy as { value: string; source: string; generation: number };
  assert.deepEqual({ value: pinned.value, source: pinned.source, generation: pinned.generation }, { value: "auto", source: "manifest", generation: 1 });
  h.reset();

  // The operator tightens this host by hand; the next update file says auto and stages anyway.
  assert.equal(await run(["policy", "set", "unlock_required", ...store, "--by", "seth", "--json"], h.ctx), EXIT.ok);
  assert.equal((h.json().applyPolicy as { source: string }).source, "operator");
  h.reset();
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply warmly to {{name}}", versionId: "ver_reply_2", variables: [{ name: "name", required: false, trust: "operator" }] })], { applyPolicy: "auto" });
  const b2 = join(work, "b2.apbundle");
  assert.equal(await run(["pull", ...scopeArgs, "--root", rootDocPath, ...keys, "--out", b2], h.ctx), EXIT.ok);
  h.reset();
  assert.equal(await run(["apply", b2, ...scopeArgs, "--root", rootPath, ...priv, "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
  assert.deepEqual({ outcome: h.json().outcome, policy: h.json().policy, said: h.json().policySaid, generation: h.json().generation }, { outcome: "staged", policy: "unlock_required", said: "auto", generation: 2 });
  h.reset();
  assert.equal(await run(["apply", b2, ...scopeArgs, "--root", rootPath, ...priv, "--state-dir", stateDir], h.ctx), EXIT.ok);
  assert.ok(h.stdout.some((l) => l.startsWith("note: the update file says auto; this host is pinned to unlock_required (set by an operator)")), h.stdout.join("\n"));
  h.reset();
  assert.equal(await run(["status", ...store, "--json"], h.ctx), EXIT.ok);
  assert.equal(h.json().generation, 1, "still serving generation 1");
  assert.equal((h.json().applyPolicyPin as { value: string }).value, "unlock_required");
  h.reset();
  assert.equal(await run(["status", ...store], h.ctx), EXIT.ok);
  assert.ok(h.stdout.some((l) => l === "apply policy: unlock_required — set by an operator on this host"), h.stdout.join("\n"));
  h.reset();

  // Loosened by the operator: the staged release still needs its unlock (loosening is not an unlock); the next file applies.
  assert.equal(await run(["policy", "set", "auto", ...store, "--json"], h.ctx), EXIT.ok);
  h.reset();
  assert.equal(await run(["status", ...store, "--json"], h.ctx), EXIT.ok);
  assert.equal(h.json().stagedSlot, "B", "loosening did not activate what was staged");
  h.reset();
  assert.equal(await run(["unlock", ...store, "--json"], h.ctx), EXIT.ok);
  assert.equal(h.json().generation, 2);
  h.reset();
  // An update file that says unlock_required tightens the pin again over the operator's auto.
  plane.promote([plane.slot({ tag: "support.reply", text: "Reply thrice to {{name}}", versionId: "ver_reply_3", variables: [{ name: "name", required: false, trust: "operator" }] })], { applyPolicy: "unlock_required" });
  const b3 = join(work, "b3.apbundle");
  assert.equal(await run(["pull", ...scopeArgs, "--root", rootDocPath, ...keys, "--out", b3], h.ctx), EXIT.ok);
  h.reset();
  assert.equal(await run(["apply", b3, ...scopeArgs, "--root", rootPath, ...priv, "--state-dir", stateDir, "--json"], h.ctx), EXIT.ok);
  assert.equal(h.json().outcome, "staged");
  h.reset();
  assert.equal(await run(["policy", "show", ...store, "--json"], h.ctx), EXIT.ok);
  assert.deepEqual({ value: (h.json().applyPolicy as { value: string }).value, source: (h.json().applyPolicy as { source: string }).source }, { value: "unlock_required", source: "manifest" });
  h.reset();
  assert.equal(await run(["policy", "set", "sometimes", ...store], h.ctx), EXIT.usage);
  assert.equal(await run(["policy", ...store], h.ctx), EXIT.usage);
  assert.equal(h.all().includes("Reply"), false, "no command output carries prompt text");
  rmSync(work, { recursive: true, force: true });
});
