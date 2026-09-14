#!/usr/bin/env node
// The verify action's body (S14): inputs from INPUT_* (as action.yml sets
// them), the CLI from a signed release unless `binary` names one, one
// `airprompter verify --json` per bundle, the results as step outputs, a
// job-summary table, and a non-zero exit when any bundle is refused.
// Node's standard library only — the action installs nothing.
//
// Rules, each a vector in cli/test/action.test.ts:
// - A downloaded executable runs only after its SHA-256 matched the
//   release's `.sha256`, and (by default) its Sigstore bundle verified
//   against this repository's release workflow identity.
// - A distribution key reaches the CLI as a file path, never as a value.
// - Every bundle is tried; the summary names each refusal's step and reason.
// - Nothing printed is prompt text: the CLI's --json document is what is
//   shown, and that document never carries a payload.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "airprompter/airprompter-agent-sdk";
const RELEASE_IDENTITY = `^https://github.com/${REPO}/`;
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";

const input = (name, fallback = "") => (process.env[`INPUT_${name}`] ?? fallback).trim();
const truthy = (value) => /^(true|1|yes)$/i.test(value);

/** `a/*.apbundle` (one per line) → files. A pattern with no match is an error: a typo must not pass silently. */
export function expandBundles(spec, cwd = process.cwd()) {
  const files = [];
  for (const raw of spec.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (!/[*?]/.test(raw)) {
      files.push(resolve(cwd, raw));
      continue;
    }
    const dir = resolve(cwd, dirname(raw));
    const pattern = new RegExp(`^${basename(raw).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    const matched = existsSync(dir) ? readdirSync(dir).filter((name) => pattern.test(name)).sort().map((name) => join(dir, name)) : [];
    if (matched.length === 0) throw new Error(`bundle: nothing matches ${raw}`);
    files.push(...matched);
  }
  return files;
}

function assetFor(platform = process.platform, arch = process.arch) {
  if (platform === "linux" && arch === "x64") return "airprompter-linux-x64";
  if (platform === "linux" && arch === "arm64") return "airprompter-linux-arm64";
  if (platform === "darwin" && arch === "arm64") return "airprompter-darwin-arm64";
  if (platform === "win32" && arch === "x64") return "airprompter-windows-x64.exe";
  throw new Error(`no release executable for ${platform}/${arch}; pass binary:`);
}

async function download(url) {
  const response = await fetch(url, { headers: { "user-agent": "airprompter-verify-action", ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** The executable for this runner from the `cli/vX.Y.Z` release: checksum always, Sigstore by default. */
export async function fetchBinary({ version, verifySignature, dir }) {
  const tag = version.startsWith("cli/v") ? version : `cli/v${version.replace(/^v/, "")}`;
  const asset = assetFor();
  mkdirSync(dir, { recursive: true });
  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  const binary = join(dir, asset);
  writeFileSync(binary, await download(`${base}/${asset}`));
  const expected = (await download(`${base}/${asset}.sha256`)).toString("utf8").trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(readFileSync(binary)).digest("hex");
  if (expected !== actual) throw new Error(`${asset}: SHA-256 ${actual} does not match the release's ${expected}`);
  if (verifySignature) {
    const bundle = join(dir, `${asset}.sigstore`);
    writeFileSync(bundle, await download(`${base}/${asset}.sigstore`));
    const cosign = spawnSync("cosign", ["verify-blob", "--bundle", bundle, "--certificate-identity-regexp", RELEASE_IDENTITY, "--certificate-oidc-issuer", OIDC_ISSUER, binary], { encoding: "utf8" });
    if (cosign.error) throw new Error("cosign is not on the runner: add sigstore/cosign-installer to the job, or set verify-signature: false");
    if (cosign.status !== 0) throw new Error(`${asset}: Sigstore verification failed: ${(cosign.stderr || cosign.stdout).trim().split("\n").slice(-2).join(" ")}`);
  }
  if (process.platform !== "win32") chmodSync(binary, 0o755);
  return { binary, tag, asset, signatureVerified: verifySignature };
}

/** The CLI as a command line: a built executable as itself; a .cjs/.mjs/.js through node; a .ts through node + tsx (this repository's own tests). */
export function commandFor(binary) {
  if (/\.ts$/.test(binary)) return [process.execPath, "--import", "tsx", binary];
  if (/\.(c|m)?js$/.test(binary)) return [process.execPath, binary];
  return [binary];
}

export function verifyOne({ binary, bundle, org, agent, environment, root, distributionKey }) {
  const [command, ...prefix] = commandFor(binary);
  const args = [...prefix, "verify", bundle, "--org", org, "--agent", agent, "--environment", environment, "--root", root, ...(distributionKey ? ["--distribution-key", distributionKey] : []), "--json"];
  const result = spawnSync(command, args, { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  let doc = null;
  try {
    doc = JSON.parse(result.stdout.trim().split("\n").pop() ?? "");
  } catch {
    doc = null;
  }
  return { bundle, exit: result.status, doc, stderr: (result.stderr ?? "").trim() };
}

function summaryRow(entry) {
  const d = entry.doc ?? {};
  const m = d.manifest ?? {};
  const verdict = entry.exit === 0 && d.ok ? "✅ verified" : `❌ refused${d.step ? ` at ${d.step}` : ""}${d.reason ? ` (${d.reason})` : entry.stderr ? ` (${entry.stderr.split("\n")[0]})` : ""}`;
  return `| \`${basename(entry.bundle)}\` | ${verdict} | ${m.generation ?? "—"} | ${m.releaseDigest ? `\`${String(m.releaseDigest).slice(0, 19)}…\`` : "—"} | ${m.slots ?? "—"} | ${d.notAfter ?? "—"}${d.expiringSoon ? " ⚠️ expiring" : ""}${d.expired ? " ⚠️ expired" : ""} | ${d.signingKeyId ? `\`${d.signingKeyId}\`` : "—"} |`;
}

export async function main(env = process.env) {
  const bundles = expandBundles(input("BUNDLE"));
  const org = input("ORG");
  const agent = input("AGENT");
  const environment = input("ENVIRONMENT");
  const root = resolve(input("ROOT"));
  const distributionKey = input("DISTRIBUTION_KEY") ? resolve(input("DISTRIBUTION_KEY")) : "";
  for (const [name, value] of [["org", org], ["agent", agent], ["environment", environment]]) if (!value) throw new Error(`${name} is required`);
  if (!existsSync(root)) throw new Error(`root: ${root} does not exist`);
  if (distributionKey && !existsSync(distributionKey)) throw new Error(`distribution-key: ${distributionKey} does not exist`);
  const failOnExpiring = truthy(input("FAIL_ON_EXPIRING", "false"));

  let binary = input("BINARY");
  let provenance = "binary supplied by the job";
  if (binary) binary = resolve(binary);
  else {
    const version = input("VERSION") || (env.ACTION_REF ?? "");
    if (!version || !/^(cli\/)?v?\d+\.\d+\.\d+$/.test(version)) throw new Error(`version: a cli/vX.Y.Z release tag is needed (got "${version || "nothing"}"); use the action at a release tag, set version:, or pass binary:`);
    const fetched = await fetchBinary({ version, verifySignature: truthy(input("VERIFY_SIGNATURE", "true")), dir: join(env.RUNNER_TEMP ?? tmpdir(), "airprompter-verify-action") });
    binary = fetched.binary;
    provenance = `${fetched.asset} from release ${fetched.tag}, SHA-256 checked${fetched.signatureVerified ? ", Sigstore verified" : ""}`;
  }

  const entries = bundles.map((bundle) => verifyOne({ binary, bundle, org, agent, environment, root, distributionKey }));
  const refused = entries.filter((e) => !(e.exit === 0 && e.doc?.ok) || (failOnExpiring && e.doc?.expiringSoon));
  const last = entries[entries.length - 1];
  const reportPath = join(env.RUNNER_TEMP ?? tmpdir(), `airprompter-verify-${process.pid}.json`);
  writeFileSync(reportPath, JSON.stringify({ ok: refused.length === 0, provenance, bundles: entries.map((e) => ({ bundle: e.bundle, exit: e.exit, report: e.doc })) }, null, 2));
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `ok=${refused.length === 0}\ngeneration=${last?.doc?.manifest?.generation ?? ""}\nrelease-digest=${last?.doc?.manifest?.releaseDigest ?? ""}\nreport=${reportPath}\n`);
  const summary = ["## AirPrompter bundle verification", "", `${entries.length - refused.length} of ${entries.length} bundle${entries.length === 1 ? "" : "s"} verified — ${provenance}.`, "", "| Bundle | Verdict | Generation | Release | Slots | Not after | Signed by |", "|---|---|---|---|---|---|---|", ...entries.map(summaryRow), ""].join("\n");
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  for (const e of entries) console.log(`${e.exit === 0 && e.doc?.ok ? "ok  " : "FAIL"} ${e.bundle}${e.doc?.manifest ? ` generation ${e.doc.manifest.generation}` : ""}${e.doc && !e.doc.ok ? ` — refused at ${e.doc.step}: ${e.doc.reason}` : e.exit !== 0 && !e.doc ? ` — ${e.stderr.split("\n")[0]}` : ""}${failOnExpiring && e.doc?.expiringSoon ? " — expiring soon" : ""}`);
  for (const e of refused) console.log(`::error file=${e.bundle}::airprompter verify refused ${basename(e.bundle)}${e.doc?.step ? ` at ${e.doc.step} (${e.doc.reason})` : ""}`);
  return refused.length === 0 ? 0 : 1;
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.log(`::error::${error.message}`);
      process.exit(2);
    },
  );
}
