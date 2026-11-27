#!/usr/bin/env node
// The release's `.sha256` beside each CLI asset: one line, `<hex>  <basename>`
// (the format `sha256sum`/`shasum -a 256` print and `-c` reads), naming the
// bare file so that `shasum -a 256 -c airprompter-linux-x64.sha256` works in
// the folder the asset was downloaded to. Hashed here rather than with the
// runner's tool, so every platform writes the same line (no `dist/` prefix,
// no `*` binary-mode marker, no CRLF).
//
//   $ node scripts/checksum.mjs <asset>     # writes <asset>.sha256 and prints its line

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const asset = process.argv[2] ? resolve(process.argv[2]) : "";
if (!asset || !existsSync(asset) || !statSync(asset).isFile()) {
  console.error("usage: checksum.mjs <asset>");
  process.exit(2);
}
const name = basename(asset);
const hex = createHash("sha256").update(readFileSync(asset)).digest("hex");
const line = `${hex}  ${name}\n`;
writeFileSync(`${asset}.sha256`, line);

// Read it back: exactly one line, the bare name, the asset's digest.
const written = readFileSync(`${asset}.sha256`, "utf8");
if (written !== line || !/^[0-9a-f]{64} {2}[^/\\\s][^/\\]*\n$/.test(written)) {
  console.error(`checksum.mjs: ${asset}.sha256 is not "<hex>  ${name}": ${JSON.stringify(written)}`);
  process.exit(1);
}
process.stdout.write(line);
