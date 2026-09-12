#!/usr/bin/env node
// Binary smoke test, run in CI on every platform against the built
// executable: version, help, keygen (files, modes, worktree refusal), a
// verify refusal with the exit-code contract, and --json output shape.
//
//   node scripts/smoke.mjs <path-to-binary>

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary = resolve(process.argv[2] ?? "");
if (!binary || !existsSync(binary)) {
  console.error("usage: smoke.mjs <binary>");
  process.exit(2);
}
let failures = 0;
const check = (label, condition, detail = "") => {
  console.log(`${condition ? "  ok  " : "  FAIL"} ${label}${condition || !detail ? "" : `\n        ${detail}`}`);
  if (!condition) failures += 1;
};
// A .cjs bundle (local runs) goes through node; a built executable runs as itself.
const viaNode = /\.c?js$/.test(binary);
const run = (args, opts = {}) => {
  const result = viaNode ? spawnSync(process.execPath, [binary, ...args], { encoding: "utf8", ...opts }) : spawnSync(binary, args, { encoding: "utf8", ...opts });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const work = mkdtempSync(join(tmpdir(), "airprompter-smoke-"));
try {
  const version = run(["--version"]);
  check("--version exits 0 and prints a version", version.code === 0 && /^\d+\.\d+\.\d+/.test(version.stdout.trim()), `${version.code}: ${version.stdout}${version.stderr}`);

  const help = run(["--help"]);
  check("--help lists every command", help.code === 0 && ["pull", "verify", "apply", "status", "diff", "keygen"].every((c) => help.stdout.includes(`  ${c}`)));

  const none = run([]);
  check("no command exits 2 (usage)", none.code === 2);

  const unknown = run(["frobnicate"]);
  check("unknown command exits 2", unknown.code === 2 && unknown.stderr.includes("unknown command"));

  const keys = join(work, "keys");
  const keygen = run(["keygen", "--purpose", "distribution", "--out", join(keys, "prod"), "--json"]);
  check("keygen distribution exits 0", keygen.code === 0, keygen.stderr);
  const keygenDoc = keygen.code === 0 ? JSON.parse(keygen.stdout) : {};
  check("keygen wrote both files", existsSync(join(keys, "prod.key.json")) && existsSync(join(keys, "prod.pub.json")));
  if (process.platform !== "win32") check("private key is 0600", (statSync(join(keys, "prod.key.json")).mode & 0o777) === 0o600);
  check("keyId is a 64-hex thumbprint", /^[0-9a-f]{64}$/.test(keygenDoc.keyId ?? ""));
  const again = run(["keygen", "--purpose", "distribution", "--out", join(keys, "prod")]);
  check("keygen refuses to overwrite", again.code === 1 && again.stderr.includes("refusing"));

  const repo = join(work, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const inRepo = run(["keygen", "--purpose", "countersign", "--out", join(repo, "release")]);
  check("keygen refuses a git worktree", inRepo.code === 2 && inRepo.stderr.includes("worktree"));
  const allowed = run(["keygen", "--purpose", "countersign", "--out", join(repo, "release"), "--allow-worktree"]);
  check("--allow-worktree overrides", allowed.code === 0);
  const pub = JSON.parse(readFileSync(join(repo, "release.pub.json"), "utf8"));
  check("countersign public file is a P-256 JWK without d", pub.jwk?.kty === "EC" && pub.jwk?.crv === "P-256" && pub.jwk?.d === undefined);

  const root = join(work, "root.jwk.json");
  writeFileSync(root, JSON.stringify(pub.jwk));
  const bogus = join(work, "bogus.apbundle");
  writeFileSync(bogus, JSON.stringify({ format: "apbundle", version: 1, protocol: "0.2.5", encryption: { scheme: "none", contents: { createdAt: "2026-01-01T00:00:00Z", notAfter: "2027-01-01T00:00:00Z", manifest: { payload: { agentId: "agt_other", target: "prod" }, signatures: [] }, keySet: {}, payloads: [] } } }));
  const verify = run(["verify", bogus, "--org", "org_1", "--agent", "agt_1", "--environment", "prod", "--root", root, "--json"]);
  check("verify refuses a relabelled bundle with exit 1", verify.code === 1, `${verify.code}: ${verify.stdout}${verify.stderr}`);
  const verifyDoc = verify.stdout.trim() ? JSON.parse(verify.stdout.trim().split("\n").pop()) : {};
  check("verify --json names the step and reason", verifyDoc.ok === false && verifyDoc.step === "bundle" && verifyDoc.reason === "relabelled", verify.stdout);

  const status = run(["status", "--agent", "agt_1", "--environment", "prod", "--state-dir", join(work, "state"), "--json"]);
  check("status on an empty host exits 0 with no active release", status.code === 0 && JSON.parse(status.stdout).activeSlot === null && JSON.parse(status.stdout).storageProtection === "file_key", status.stderr);

  const noKey = run(["pull", "--org", "org_1", "--agent", "agt_1", "--environment", "prod", "--root", root, "--out", join(work, "b.apbundle")], { env: { ...process.env, AIRPROMPTER_AGENT_KEY: "" } });
  check("pull without the key env exits 2 and names the variable", noKey.code === 2 && noKey.stderr.includes("AIRPROMPTER_AGENT_KEY"), noKey.stderr);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(failures === 0 ? "smoke: all checks passed" : `smoke: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
