#!/usr/bin/env node
/**
 * The link check the customer docs promise (T18): every relative link in
 * docs/**.md, protocol/**.md, the READMEs and SECURITY.md resolves to a
 * file in this repository, and every `#anchor` on a Markdown target
 * resolves to a heading in it (GitHub's slug rule). External links are
 * listed, not fetched. Exit 1 on the first broken one.
 *
 *   $ node docs/check-links.mjs
 *
 *   node docs/check-links.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (entry.endsWith(".md")) out.push(path);
  }
  return out;
}

const files = [...walk(join(root, "docs")), ...walk(join(root, "protocol")), ...walk(join(root, "examples")), join(root, "README.md"), join(root, "SECURITY.md"), join(root, "sdk-typescript", "README.md"), join(root, "sdk-python", "README.md"), join(root, "cli", "README.md")].filter((f) => existsSync(f));

/** GitHub's heading slug: lower-case, drop punctuation except hyphens and spaces, spaces to hyphens. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function anchorsOf(path) {
  const seen = new Map();
  const out = new Set();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (!match) continue;
    const base = slug(match[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
let broken = 0;
let checked = 0;
const external = new Set();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  // Skip fenced code blocks: a link-looking thing inside them is an example, not a link.
  const prose = text.replace(/```[\s\S]*?```/g, "");
  for (const match of prose.matchAll(LINK)) {
    const target = match[1];
    if (/^[a-z]+:/i.test(target)) {
      external.add(target);
      continue;
    }
    checked += 1;
    const [pathPart, anchor] = target.split("#");
    const targetPath = pathPart ? resolve(dirname(file), pathPart) : file;
    if (!existsSync(targetPath)) {
      console.error(`BROKEN ${relative(root, file)} → ${target} (no such file)`);
      broken += 1;
      continue;
    }
    if (anchor && targetPath.endsWith(".md") && !anchorsOf(targetPath).has(anchor)) {
      console.error(`BROKEN ${relative(root, file)} → ${target} (no heading "${anchor}" in ${relative(root, targetPath)})`);
      broken += 1;
    }
  }
}
console.log(`${files.length} files, ${checked} relative links checked, ${external.size} external links listed, ${broken} broken`);
process.exit(broken === 0 ? 0 : 1);
