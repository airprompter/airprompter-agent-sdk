#!/usr/bin/env node
/**
 * @fileoverview Every source file opens with a header that says what the file is for and shows how to use it.
 *
 * The rule (CONTRIBUTING.md › "File headers"): a TypeScript / JavaScript file starts with a `/** … *\/` block (or a
 * run of `//` lines) and a Python file with a module docstring; the header explains the file in a sentence or
 * more and carries one small usage example — a `@example` fenced block, an `Example::` / `Usage:` block, or an
 * indented snippet. Tests, generated declarations and vendored code are exempt. Plain Node, no dependencies, so
 * it runs anywhere CI does:
 *
 *   node scripts/check-headers.mjs            # lists every file that misses the rule; exit 1 when any does
 *   node scripts/check-headers.mjs --list     # also lists the files that pass
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, basename, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const ROOTS = ["sdk-typescript/packages", "sdk-python/packages", "cli/src", "conformance", "examples", "action", "protocol/tools", "deploy", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".venv", "__pycache__", "cdk.out", ".airprompter-dev", "vendor"]);
const EXT = new Set([".ts", ".mjs", ".js", ".py"]);
const list = process.argv.includes("--list");

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* walk(path);
      continue;
    }
    const ext = extname(entry);
    if (!EXT.has(ext) || entry.endsWith(".d.ts")) continue;
    const rel = relative(root, path).split(sep).join("/");
    if (/(^|\/)(test|tests)\//.test(rel) || /\.test\.(ts|mjs|js)$/.test(entry) || /^test_.*\.py$/.test(entry) || entry === "conftest.py") continue;
    yield path;
  }
}

/** The header: a leading docstring (Python) or a leading block / line-comment run (JS/TS), after any shebang. */
function headerOf(source, isPython) {
  let text = source.replace(/^﻿/, "");
  if (text.startsWith("#!")) text = text.slice(text.indexOf("\n") + 1);
  text = text.replace(/^\s+/, "");
  if (isPython) {
    const match = /^("""|''')([\s\S]*?)\1/.exec(text);
    return match ? match[2] : null;
  }
  if (text.startsWith("/*")) {
    const end = text.indexOf("*/");
    return end === -1 ? null : text.slice(2, end);
  }
  if (text.startsWith("//")) {
    const lines = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("//")) break;
      lines.push(line.slice(2));
    }
    return lines.join("\n");
  }
  return null;
}

const EXAMPLE = /@example|@usage|Example::|Examples::|Usage::|Usage:|```|^\s*\$ |^ {2,}\S+.*\(/m;

const failures = [];
let passed = 0;
for (const dir of ROOTS) {
  for (const path of walk(join(root, dir))) {
    const rel = relative(root, path).split(sep).join("/");
    const isPython = path.endsWith(".py");
    const header = headerOf(readFileSync(path, "utf8"), isPython);
    if (header === null || header.trim().length < 40) {
      failures.push(`${rel}: no header (a comment or docstring at the top that says what this file is for)`);
      continue;
    }
    if (!EXAMPLE.test(header)) {
      failures.push(`${rel}: the header has no usage example (@example, Example::, Usage:, a fenced or indented snippet)`);
      continue;
    }
    passed += 1;
    if (list) console.log(`ok   ${rel}`);
  }
}

for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(`check-headers: ${passed} files pass, ${failures.length} fail`);
process.exit(failures.length === 0 ? 0 : 1);
