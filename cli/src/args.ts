/**
 * Option parsing on `node:util` — no dependency, one place for the shared flags.
 *
 * @example
 * ```ts
 * const parsed = parse(argv, { ...SCOPE_OPTIONS, ...ROOT_OPTIONS, ...STORE_OPTIONS, ...COMMON_OPTIONS });
 * if (flag(parsed, "help")) ctx.stdout(helpFor("verify", "<bundle.apbundle | state-dir> --org … --agent … --environment … --root …", spec));
 * const scope = scopeOf(parsed);                        // a usage error names the first of --org / --agent / --environment that is missing
 * const store = await openStore(parsed, ctx, scope);    // --state-dir, or the OS state directory
 * ```
 */

import { parseArgs } from "node:util";

import { fileKey } from "../../sdk-typescript/packages/sync/src/store/keyProvider.js";
import { CLI_VERSION } from "./version.js";
import { SlotStore } from "../../sdk-typescript/packages/sync/src/store/slotStore.js";
import { TARGET_SLUG, type HostedEnvironment, type Target } from "../../sdk-typescript/packages/core/src/protocol/types.js";
import { join } from "node:path";
import type { Scope } from "./chain.js";
import { requireOption, usage, type Context } from "./io.js";
import { loadRoot, type RootSource } from "./keys.js";

export type OptionSpec = Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean; default?: string | boolean; help: string }>;

export const SCOPE_OPTIONS: OptionSpec = {
  org: { type: "string", help: "Organization id (org_…)" },
  agent: { type: "string", help: "Agent id (agt_…)" },
  environment: { type: "string", help: "The agent's stage: a slug such as dev, qa or prod" },
  "hosted-environment": { type: "string", help: "Which AirPrompter deployment a pinned --root belongs to: prod (the public service, default), staging or dev — not this app's --environment" },
};

export const ROOT_OPTIONS: OptionSpec = {
  root: { type: "string", help: "Pinned root public JWK file, or a signed root document (root.json)" },
};

export const STORE_OPTIONS: OptionSpec = {
  "state-dir": { type: "string", help: "State directory (default: the OS state directory)" },
};

export const COMMON_OPTIONS: OptionSpec = {
  json: { type: "boolean", default: false, help: "One JSON document on stdout" },
  help: { type: "boolean", short: "h", default: false, help: "Show help" },
};

export interface Parsed {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}

export function parse(argv: string[], spec: OptionSpec): Parsed {
  const options: NonNullable<NonNullable<Parameters<typeof parseArgs>[0]>["options"]> = {};
  for (const [name, entry] of Object.entries(spec)) {
    options[name] = { type: entry.type, ...(entry.short ? { short: entry.short } : {}), ...(entry.multiple ? { multiple: true } : {}), ...(entry.default !== undefined ? { default: entry.default } : {}) } as never;
  }
  try {
    const result = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    return { values: result.values as Parsed["values"], positionals: result.positionals };
  } catch (error) {
    throw usage((error as Error).message);
  }
}

export function str(parsed: Parsed, name: string): string | undefined {
  const value = parsed.values[name];
  return typeof value === "string" ? value : undefined;
}

export function flag(parsed: Parsed, name: string): boolean {
  return parsed.values[name] === true;
}

/** An agent's stage is a slug: the CLI checks the shape, not the names. */
export const TARGET = TARGET_SLUG;
export const TARGET_USAGE = "--environment must be a lowercase slug: a letter, then up to 31 letters, digits or hyphens";

export function scopeOf(parsed: Parsed): Scope {
  const target = requireOption(str(parsed, "environment"), "environment");
  if (!TARGET.test(target)) throw usage(TARGET_USAGE);
  return { organizationId: requireOption(str(parsed, "org"), "org"), agentId: requireOption(str(parsed, "agent"), "agent"), target: target as Target };
}

export function hostedEnvironmentOf(parsed: Parsed): HostedEnvironment {
  const hosted = str(parsed, "hosted-environment") ?? "prod";
  if (hosted !== "dev" && hosted !== "staging" && hosted !== "prod") throw usage("--hosted-environment must be dev, staging or prod");
  return hosted;
}

export function rootOf(parsed: Parsed, target: Target): RootSource {
  return loadRoot(requireOption(str(parsed, "root"), "root"), hostedEnvironmentOf(parsed));
}

export function defaultStateDir(ctx: Context): string {
  const home = ctx.env.HOME ?? ctx.env.USERPROFILE ?? ctx.cwd;
  if (ctx.env.XDG_STATE_HOME) return ctx.env.XDG_STATE_HOME;
  if (process.platform === "darwin") return join(home, "Library", "Application Support");
  if (process.platform === "win32") return ctx.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  return join(home, ".local", "state");
}

export async function openStore(parsed: Parsed, ctx: Context, scope: { agentId: string; target: Target }): Promise<SlotStore> {
  const stateDir = str(parsed, "state-dir") ?? defaultStateDir(ctx);
  // S8: a CLI write (apply, unlock, policy set) names the CLI as store.json's writer.
  return SlotStore.open({ stateDir, agentId: scope.agentId, target: scope.target, keyProvider: fileKey(join(SlotStore.path({ stateDir, agentId: scope.agentId, target: scope.target }), "store.key")), hooks: { writer: { name: "airprompter-cli", version: CLI_VERSION } } });
}

export function helpFor(command: string, synopsis: string, spec: OptionSpec): string {
  const width = Math.max(...Object.keys(spec).map((name) => name.length)) + 2;
  const lines = Object.entries(spec).map(([name, entry]) => `  --${name.padEnd(width)}${entry.help}${entry.default !== undefined && entry.default !== false ? ` (default: ${String(entry.default)})` : ""}`);
  return [`Usage: airprompter ${command} ${synopsis}`, "", ...lines].join("\n");
}
