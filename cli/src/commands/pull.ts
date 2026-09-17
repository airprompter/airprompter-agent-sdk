/**
 * `airprompter pull`: fetch the current release for a target, verify the
 * whole chain, and write it as an `.apbundle` encrypted to the target's
 * distribution key (plaintext is a `dev` opt-in). A content-free sidecar
 * (`<out>.meta.json`) records what was vendored so `pull --check` can say
 * how far behind a build is without opening the bundle.
 *
 * `pull --tags-only` is the hosted counterpart (T23): with a RUN key and the
 * hosted run URL as `--base-url`, it writes the environment's catalogue —
 * slot tags, declared variables, workflow step ids, the experiment's salt and
 * arms — with no payloads and no trust chain to verify, for build steps that
 * want to know what a hosted app may call before it runs.
 *
 * Nothing this command prints is payload text, at any verbosity.
 *
 * @example
 * ```sh
 * AIRPROMPTER_AGENT_KEY=… airprompter pull --org org_… --agent agt_… --environment prod \
 *   --root ./airprompter-root.jwk.json --root-url https://<edge>/roots/prod/root.json \
 *   --distribution-key ./prod.pub.json --out airprompter.bundle.apbundle
 * AIRPROMPTER_AGENT_KEY=… airprompter pull --check --max-behind 2 --org org_… --agent agt_… --environment prod --out airprompter.bundle.apbundle
 * ```
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createEncryptedBundle, createPlaintextBundle, distributionKeyId } from "../../../sdk-typescript/packages/core/src/bundle/apbundle.js";
import { referencedPayloads } from "../../../sdk-typescript/packages/core/src/protocol/trust.js";
import type { BundleContents, RootMetadata } from "../../../sdk-typescript/packages/core/src/protocol/types.js";
import { ManagedAgent, isManagedRunError } from "../../../sdk-typescript/packages/runtime/src/managed/client.js";
import { SyncClient } from "../../../sdk-typescript/packages/core/src/control/client.js";
import { COMMON_OPTIONS, ROOT_OPTIONS, SCOPE_OPTIONS, flag, helpFor, parse, rootOf, scopeOf, str, type OptionSpec } from "../args.js";
import { summarizeManifest, verifyChain } from "../chain.js";
import { CliError, EXIT, Output, refused, requireOption, usage, type Context } from "../io.js";
import { loadDistributionPublicKey } from "../keys.js";
import { CLI_VERSION } from "../version.js";

export const PULL_OPTIONS: OptionSpec = {
  ...SCOPE_OPTIONS,
  ...ROOT_OPTIONS,
  "root-url": { type: "string", help: "URL of the environment's root.json (verified against --root before use)" },
  "api-key-env": { type: "string", default: "AIRPROMPTER_AGENT_KEY", help: "Environment variable holding the Agent key (never passed on argv)" },
  "base-url": { type: "string", default: "https://api.airprompter.com", help: "API base URL" },
  "distribution-key": { type: "string", help: "The target's distribution PUBLIC key (.pub.json or base64url) to encrypt the bundle to" },
  out: { type: "string", help: "Output path, e.g. airprompter.bundle.apbundle" },
  plaintext: { type: "boolean", default: false, help: "Write an unencrypted bundle (dev environment only)" },
  "not-after-days": { type: "string", default: "90", help: "Days until the bundle's notAfter (the platform's update-file default; 365 at most)" },
  check: { type: "boolean", default: false, help: "Do not pull: compare the vendored bundle's sidecar with the current generation" },
  "tags-only": { type: "boolean", default: false, help: "Hosted environments: write the catalogue (tags, variables, step ids, experiment arms) with a RUN key; --base-url is the hosted run URL; no payloads, no root" },
  "max-behind": { type: "string", default: "0", help: "With --check: generations the vendored bundle may be behind before exit 3" },
  ...COMMON_OPTIONS,
};

export interface BundleSidecar {
  kind: "airprompter-bundle-meta";
  v: 1;
  organizationId: string;
  agentId: string;
  target: string;
  generation: number;
  releaseDigest: string;
  createdAt: string;
  notAfter: string;
  encryption: "none" | "hpke";
  recipientKeyId: string | null;
  cli: string;
}

export const sidecarPath = (out: string): string => `${out}.meta.json`;

export async function pull(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, PULL_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("pull", "--org … --agent … --environment … --root … --out …", PULL_OPTIONS));
    return EXIT.ok;
  }
  const out = new Output(ctx, flag(parsed, "json"));
  const scope = scopeOf(parsed);
  const apiKeyEnv = str(parsed, "api-key-env") ?? "AIRPROMPTER_AGENT_KEY";
  const apiKey = ctx.env[apiKeyEnv];
  if (!apiKey) throw usage(`${apiKeyEnv} is not set (the Agent key is read from the environment, never from argv)`);
  if (!ctx.fetch) throw usage("no fetch available: Node 20+ is required");

  if (flag(parsed, "tags-only")) {
    const target = requireOption(str(parsed, "out"), "out");
    let agent: ManagedAgent;
    try {
      agent = await ManagedAgent.start({ agentId: scope.agentId, target: scope.target, apiKey, baseUrl: str(parsed, "base-url") ?? "https://api.airprompter.com", fetch: ctx.fetch as never, userAgent: `airprompter-cli/${CLI_VERSION}` });
    } catch (error) {
      if (isManagedRunError(error)) throw refused(`the run key was not accepted for the catalogue (${error.code}${error.detail ? `: ${error.detail}` : ""})`, { reason: error.code });
      throw error;
    }
    const catalogue = agent.slots;
    mkdirSync(dirname(target) || ".", { recursive: true });
    writeFileSync(target, `${JSON.stringify({ kind: "airprompter-hosted-catalogue", v: 1, pulledAt: new Date(ctx.now()).toISOString(), cli: CLI_VERSION, ...catalogue }, null, 2)}\n`);
    out.field("generation", catalogue.generation);
    out.field("releaseDigest", catalogue.releaseDigest, "release");
    out.field("slots", catalogue.slots.map((s) => `${s.tag} (${s.kind}${s.steps ? `, ${s.steps.length} steps` : ""}, ${s.variables.length} vars)`));
    out.field("experiment", catalogue.experiment ? `${catalogue.experiment.arms.join(" / ")} by ${catalogue.experiment.subjectKey}` : "none");
    out.field("out", target);
    out.flush();
    return EXIT.ok;
  }

  const client = new SyncClient({ baseUrl: str(parsed, "base-url") ?? "https://api.airprompter.com", agentId: scope.agentId, target: scope.target, apiKey, fetch: ctx.fetch, userAgent: `airprompter-cli/${CLI_VERSION}` });

  const fetched = await client.manifest({});
  if (fetched.status === "not_found") throw refused("nothing is promoted to this environment (or the key does not cover it)", { reason: "not_found" });
  if (fetched.status === "unauthorized") throw refused("the Agent key was not accepted", { reason: "unauthorized" });
  if (fetched.status === "forbidden") throw refused(`the Agent key is not allowed here (${fetched.code ?? "forbidden"})`, { reason: fetched.code ?? "forbidden" });
  if (fetched.status === "error") throw refused(`manifest fetch failed with HTTP ${fetched.httpStatus}`, { reason: `http_${fetched.httpStatus}` });
  if (fetched.status === "not_modified") throw refused("unexpected 304 without an ETag", { reason: "protocol" });
  const manifest = fetched.manifest;

  if (flag(parsed, "check")) {
    const target = requireOption(str(parsed, "out"), "out");
    const path = sidecarPath(target);
    if (!existsSync(path)) throw usage(`${path} not found: pull first, then --check the sidecar it wrote`);
    const meta = JSON.parse(readFileSync(path, "utf8")) as Partial<BundleSidecar>;
    if (meta.kind !== "airprompter-bundle-meta" || typeof meta.generation !== "number") throw usage(`${path}: not a bundle sidecar`);
    if (meta.agentId !== scope.agentId || meta.target !== scope.target) throw usage(`${path} is for ${meta.agentId}/${meta.target}, not ${scope.agentId}/${scope.target}`);
    const maxBehind = Number(str(parsed, "max-behind") ?? "0");
    if (!Number.isInteger(maxBehind) || maxBehind < 0) throw usage("--max-behind must be a non-negative integer");
    const behind = Math.max(0, manifest.payload.generation - meta.generation);
    const stale = behind > maxBehind;
    out.field("vendoredGeneration", meta.generation, "vendored generation");
    out.field("currentGeneration", manifest.payload.generation, "current generation");
    out.field("behind", behind);
    out.field("maxBehind", maxBehind, "max behind");
    out.field("sameRelease", meta.releaseDigest === manifest.payload.releaseDigest, "same release");
    out.field("stale", stale);
    out.flush();
    if (stale) {
      ctx.stderr(`stale: the vendored bundle is ${behind} generation${behind === 1 ? "" : "s"} behind (max ${maxBehind}); run airprompter pull`);
      return EXIT.stale;
    }
    return EXIT.ok;
  }

  const target = requireOption(str(parsed, "out"), "out");
  const root = rootOf(parsed, scope.target);
  const plaintext = flag(parsed, "plaintext");
  if (plaintext && scope.target !== "dev") throw usage("--plaintext is allowed for the dev environment only; every other bundle is encrypted to the target's distribution key");
  const recipient = plaintext ? null : loadDistributionPublicKey(requireOption(str(parsed, "distribution-key"), "distribution-key"));

  // The bundle carries a key-set document; a pinned key alone does not name the signing keys.
  let keySet: RootMetadata | null = root.kind === "document" ? root.document : null;
  const rootUrl = str(parsed, "root-url");
  if (rootUrl) {
    const response = await ctx.fetch(rootUrl, { headers: { "user-agent": `airprompter-cli/${CLI_VERSION}` } });
    if (response.status !== 200) throw refused(`root document fetch failed with HTTP ${response.status}`, { reason: `root_http_${response.status}` });
    keySet = JSON.parse(await response.text()) as RootMetadata;
  }

  const payloads = new Map<string, Uint8Array>();
  for (const [hash, byteLength] of referencedPayloads(manifest.payload)) {
    const bytes = await client.payload(hash);
    if (!bytes) throw refused(`payload ${hash} was not served`, { reason: "payload_missing", contentHash: hash });
    if (bytes.length !== byteLength) throw refused(`payload ${hash}: ${bytes.length} bytes, manifest says ${byteLength}`, { reason: "payload_length_mismatch", contentHash: hash });
    payloads.set(hash, bytes);
  }
  const now = new Date(ctx.now()).toISOString();
  const report = verifyChain({ manifest, keySet, payloads, root, scope, now, storedGeneration: 0 });
  if (!report.ok) throw new CliError(EXIT.refused, `refused at ${report.step}: ${report.reason}`, { step: report.step, reason: report.reason, root: report.root });

  const days = Number(str(parsed, "not-after-days") ?? "90");
  if (!Number.isFinite(days) || days <= 0 || days > 365) throw usage("--not-after-days must be a positive number of days, 365 at most");
  const notAfter = new Date(ctx.now() + days * 86_400_000).toISOString();
  const contents: BundleContents = {
    createdAt: now,
    notAfter,
    manifest,
    keySet: report.trustedRoot,
    payloads: [...payloads].map(([contentHash, bytes]) => ({ contentHash: contentHash as `sha256:${string}`, byteLength: bytes.length, bytes: Buffer.from(bytes).toString("base64url") })),
  };
  const bundle = recipient ? createEncryptedBundle(contents, recipient) : createPlaintextBundle(contents);
  mkdirSync(dirname(target) || ".", { recursive: true });
  writeFileSync(target, `${JSON.stringify(bundle)}\n`, { mode: recipient ? 0o644 : 0o600 });
  const sidecar: BundleSidecar = {
    kind: "airprompter-bundle-meta",
    v: 1,
    organizationId: scope.organizationId,
    agentId: scope.agentId,
    target: scope.target,
    generation: manifest.payload.generation,
    releaseDigest: manifest.payload.releaseDigest,
    createdAt: now,
    notAfter,
    encryption: recipient ? "hpke" : "none",
    recipientKeyId: recipient ? distributionKeyId(recipient) : null,
    cli: CLI_VERSION,
  };
  writeFileSync(sidecarPath(target), `${JSON.stringify(sidecar, null, 2)}\n`);

  const summary = summarizeManifest(manifest);
  out.field("out", target);
  out.field("generation", summary.generation);
  out.field("releaseDigest", summary.releaseDigest, "release");
  out.field("slots", summary.slots);
  out.field("payloads", summary.payloads);
  out.field("signingKeyId", report.signingKeyId, "signed by");
  out.field("encryption", sidecar.encryption);
  out.field("recipientKeyId", sidecar.recipientKeyId, "recipient key");
  out.field("notAfter", notAfter, "not after");
  if (!recipient) out.line("warning: plaintext bundle — dev only; never commit it");
  out.flush();
  return EXIT.ok;
}
