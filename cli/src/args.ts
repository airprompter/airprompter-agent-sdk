/** Option parsing on `node:util` — no dependency, one place for the shared flags. */

import { parseArgs } from "node:util";

import { fileKey } from "../../sdk-typescript/src/store/keyProvider.js";
import { SlotStore } from "../../sdk-typescript/src/store/slotStore.js";
import type { Target } from "../../sdk-typescript/src/protocol/types.js";
import { join } from "node:path";
import type { Scope } from "./chain.js";
import { requireOption, usage, type Context } from "./io.js";
import { loadRoot, type RootSource } from "./keys.js";

export type OptionSpec = Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean; default?: string | boolean; help: string }>;

export const SCOPE_OPTIONS: OptionSpec = {
  org: { type: "string", help: "Organization id (org_…)" },
  agent: { type: "string", help: "Agent id (agt_…)" },
  environment: { type: "string", help: "dev | staging | prod" },
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

export function scopeOf(parsed: Parsed): Scope {
  const target = requireOption(str(parsed, "environment"), "environment");
  if (target !== "dev" && target !== "staging" && target !== "prod") throw usage("--environment must be dev, staging or prod");
  return { organizationId: requireOption(str(parsed, "org"), "org"), agentId: requireOption(str(parsed, "agent"), "agent"), target: target as Target };
}

export function rootOf(parsed: Parsed, target: Target): RootSource {
  return loadRoot(requireOption(str(parsed, "root"), "root"), target);
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
  return SlotStore.open({ stateDir, agentId: scope.agentId, target: scope.target, keyProvider: fileKey(join(SlotStore.path({ stateDir, agentId: scope.agentId, target: scope.target }), "store.key")) });
}

export function helpFor(command: string, synopsis: string, spec: OptionSpec): string {
  const width = Math.max(...Object.keys(spec).map((name) => name.length)) + 2;
  const lines = Object.entries(spec).map(([name, entry]) => `  --${name.padEnd(width)}${entry.help}${entry.default !== undefined && entry.default !== false ? ` (default: ${String(entry.default)})` : ""}`);
  return [`Usage: airprompter ${command} ${synopsis}`, "", ...lines].join("\n");
}
