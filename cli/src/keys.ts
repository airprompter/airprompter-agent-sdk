/**
 * Key files the CLI reads and writes, and how a root of trust is named on
 * the command line.
 *
 * - Distribution key (X25519, for `.apbundle` encryption): a private file
 *   `<name>.key.json` (0600) and a public file `<name>.pub.json`. The
 *   public half is what the customer registers on the environment.
 * - Countersign key (P-256, for the customer's release signature): a
 *   private JWK `<name>.key.json` (0600) and a public JWK `<name>.pub.json`,
 *   both carrying the RFC 7638 thumbprint as `keyId`.
 * - Root: `--root` takes either a pinned public JWK (`{kty,crv,x,y}`) or a
 *   full signed root document; the shape decides.
 *
 * Private keys are refused inside a git worktree unless `--allow-worktree`
 * says so: the one way a key ends up in a repository is by being written
 * next to the code.
 *
 * @example
 * ```ts
 * const { keyId, privatePath, publicPath } = generateDistributionKeyFiles("~/.config/airprompter/prod", now);   // prod.key.json (0600), prod.pub.json
 * const key = loadDistributionPrivateKey(privatePath);                  // what verify / apply / diff take as --distribution-key
 * const root = loadRoot("./airprompter-root.jwk.json", "prod");       // { kind: "pinned" } for a JWK, { kind: "document" } for root.json
 * ```
 */

import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { DistributionKey } from "../../sdk-typescript/packages/core/src/bundle/apbundle.js";
import { distributionKeyId } from "../../sdk-typescript/packages/core/src/bundle/apbundle.js";
import { generateX25519KeyPair, x25519PrivateKeyFromRaw } from "../../sdk-typescript/packages/core/src/bundle/hpke.js";
import { canonicalJson } from "../../sdk-typescript/packages/core/src/protocol/canonicalJson.js";
import { keyThumbprint, trustedRootFromPinnedKey } from "../../sdk-typescript/packages/core/src/protocol/trust.js";
import type { P256PrivateJwk, P256PublicJwk, RootMetadata, Target } from "../../sdk-typescript/packages/core/src/protocol/types.js";
import { refused, usage } from "./io.js";

export interface DistributionPrivateFile {
  kind: "airprompter-distribution-key";
  v: 1;
  keyId: string;
  publicKey: string;
  privateKey: string;
  createdAt: string;
}

export interface DistributionPublicFile {
  kind: "airprompter-distribution-public-key";
  v: 1;
  keyId: string;
  publicKey: string;
  createdAt: string;
}

export interface CountersignPrivateFile {
  kind: "airprompter-countersign-key";
  v: 1;
  keyId: string;
  jwk: P256PrivateJwk;
  createdAt: string;
}

export interface CountersignPublicFile {
  kind: "airprompter-countersign-public-key";
  v: 1;
  keyId: string;
  jwk: P256PublicJwk;
  createdAt: string;
}

export function insideGitWorktree(path: string): boolean {
  let dir = resolve(path);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function writePrivate(path: string, document: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) throw refused(`${path} exists; refusing to overwrite a key`);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

function writePublic(path: string, document: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) throw refused(`${path} exists; refusing to overwrite a key`);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644, flag: "wx" });
}

export function generateDistributionKeyFiles(prefix: string, now: string): { keyId: string; privatePath: string; publicPath: string } {
  const pair = generateX25519KeyPair();
  const jwk = pair.privateKey.export({ format: "jwk" }) as { d: string; x: string };
  const keyId = distributionKeyId(pair.publicRaw);
  const privatePath = `${prefix}.key.json`;
  const publicPath = `${prefix}.pub.json`;
  const publicKey = pair.publicRaw.toString("base64url");
  writePrivate(privatePath, { kind: "airprompter-distribution-key", v: 1, keyId, publicKey, privateKey: jwk.d, createdAt: now } satisfies DistributionPrivateFile);
  writePublic(publicPath, { kind: "airprompter-distribution-public-key", v: 1, keyId, publicKey, createdAt: now } satisfies DistributionPublicFile);
  return { keyId, privatePath, publicPath };
}

export function generateCountersignKeyFiles(prefix: string, now: string): { keyId: string; privatePath: string; publicPath: string } {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" }) as { x: string; y: string; d: string };
  const publicJwk: P256PublicJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
  const keyId = keyThumbprint(publicJwk);
  const privatePath = `${prefix}.key.json`;
  const publicPath = `${prefix}.pub.json`;
  writePrivate(privatePath, { kind: "airprompter-countersign-key", v: 1, keyId, jwk: { ...publicJwk, d: jwk.d }, createdAt: now } satisfies CountersignPrivateFile);
  writePublic(publicPath, { kind: "airprompter-countersign-public-key", v: 1, keyId, jwk: publicJwk, createdAt: now } satisfies CountersignPublicFile);
  return { keyId, privatePath, publicPath };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw usage(`${path}: ${(error as Error).message}`);
  }
}

/** The public half of a distribution key: a `.pub.json`, a `.key.json` (its public field), or a bare base64url raw key. */
export function loadDistributionPublicKey(value: string): Uint8Array {
  if (existsSync(value)) {
    const document = readJson(value) as Partial<DistributionPublicFile>;
    if ((document.kind === "airprompter-distribution-public-key" || document.kind === "airprompter-distribution-key") && typeof document.publicKey === "string") {
      const raw = Buffer.from(document.publicKey, "base64url");
      if (raw.length !== 32) throw usage(`${value}: publicKey is not a 32-byte X25519 key`);
      if (document.keyId && document.keyId !== distributionKeyId(raw)) throw usage(`${value}: keyId does not match the public key`);
      return raw;
    }
    throw usage(`${value}: not a distribution key file`);
  }
  const raw = Buffer.from(value, "base64url");
  if (raw.length !== 32) throw usage("--distribution-key: expected a key file or a base64url X25519 public key");
  return raw;
}

export function loadDistributionPrivateKey(path: string): DistributionKey & { keyId: string } {
  const document = readJson(path) as Partial<DistributionPrivateFile>;
  if (document.kind !== "airprompter-distribution-key" || typeof document.privateKey !== "string" || typeof document.publicKey !== "string") throw usage(`${path}: not a distribution private key file`);
  const publicRaw = Buffer.from(document.publicKey, "base64url");
  const privateRaw = Buffer.from(document.privateKey, "base64url");
  if (publicRaw.length !== 32 || privateRaw.length !== 32) throw usage(`${path}: malformed key material`);
  const keyId = distributionKeyId(publicRaw);
  if (document.keyId && document.keyId !== keyId) throw usage(`${path}: keyId does not match the public key`);
  return { privateKey: x25519PrivateKeyFromRaw(privateRaw, publicRaw), publicRaw, keyId };
}

export type RootSource = { kind: "pinned"; jwk: P256PublicJwk; trusted: RootMetadata } | { kind: "document"; document: RootMetadata };

/** `--root`: a pinned public JWK or a signed root document; the shape decides. A pinned key is scoped to the HOSTED environment (`--hosted-environment`, default prod), never to the app's target. */
export function loadRoot(value: string, environment: Target): RootSource {
  const document = readJson(value) as Record<string, unknown>;
  if (document.kty === "EC" && document.crv === "P-256" && typeof document.x === "string" && typeof document.y === "string") {
    const jwk: P256PublicJwk = { kty: "EC", crv: "P-256", x: document.x, y: document.y };
    return { kind: "pinned", jwk, trusted: trustedRootFromPinnedKey({ purpose: "platform", environment, pinnedRoot: jwk }) };
  }
  if (document.signed && Array.isArray(document.signatures)) return { kind: "document", document: document as unknown as RootMetadata };
  throw usage(`${value}: expected a pinned public JWK ({kty,crv,x,y}) or a signed root document`);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fingerprintOf(document: unknown): string {
  return sha256Hex(Buffer.from(canonicalJson(document), "utf8")).slice(0, 16);
}

export type { KeyObject };
