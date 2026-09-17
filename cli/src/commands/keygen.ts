/**
 * `airprompter keygen --purpose distribution | countersign --out <prefix>`:
 * a keypair in the customer's chosen place. The private half is written
 * 0600, never overwritten, and refused inside a git worktree unless
 * `--allow-worktree` says the customer knows what they are doing.
 *
 * @example
 * ```sh
 * airprompter keygen --purpose distribution --out ~/.config/airprompter/prod     # writes prod.key.json (0600) and prod.pub.json
 * ```
 */

import { dirname, resolve } from "node:path";

import { COMMON_OPTIONS, flag, helpFor, parse, str, type OptionSpec } from "../args.js";
import { EXIT, Output, requireOption, usage, type Context } from "../io.js";
import { generateCountersignKeyFiles, generateDistributionKeyFiles, insideGitWorktree } from "../keys.js";

export const KEYGEN_OPTIONS: OptionSpec = {
  purpose: { type: "string", help: "distribution (X25519, bundle encryption) | countersign (P-256, customer release signature)" },
  out: { type: "string", help: "Path prefix: writes <prefix>.key.json (private, 0600) and <prefix>.pub.json" },
  "allow-worktree": { type: "boolean", default: false, help: "Write a private key inside a git worktree anyway" },
  ...COMMON_OPTIONS,
};

export async function keygen(argv: string[], ctx: Context): Promise<number> {
  const parsed = parse(argv, KEYGEN_OPTIONS);
  if (flag(parsed, "help")) {
    ctx.stdout(helpFor("keygen", "--purpose distribution|countersign --out <prefix>", KEYGEN_OPTIONS));
    return EXIT.ok;
  }
  const out = new Output(ctx, flag(parsed, "json"));
  const purpose = requireOption(str(parsed, "purpose"), "purpose");
  if (purpose !== "distribution" && purpose !== "countersign") throw usage("--purpose must be distribution or countersign");
  const prefix = resolve(ctx.cwd, requireOption(str(parsed, "out"), "out"));
  if (!flag(parsed, "allow-worktree") && insideGitWorktree(dirname(prefix))) {
    throw usage(`${dirname(prefix)} is inside a git worktree; a private key written next to code ends up committed. Choose a path outside the repository or pass --allow-worktree.`);
  }
  const now = new Date(ctx.now()).toISOString();
  const written = purpose === "distribution" ? generateDistributionKeyFiles(prefix, now) : generateCountersignKeyFiles(prefix, now);
  out.field("purpose", purpose);
  out.field("keyId", written.keyId, "key id");
  out.field("privateKey", written.privatePath, "private key (0600)");
  out.field("publicKey", written.publicPath, "public key");
  out.line(purpose === "distribution" ? "register the public key on the environment (Agent › Settings › Distribution key); keep the private key in your secret store — the runtime needs it to open bundles" : "register the public key on the environment (Agent › Settings › Countersign key); the private key signs releases with airprompter countersign");
  out.flush();
  return EXIT.ok;
}
