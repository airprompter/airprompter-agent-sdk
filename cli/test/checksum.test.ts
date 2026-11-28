/**
 * The release's `.sha256` (scripts/checksum.mjs, run by release.yml beside every CLI asset) names the bare file, so
 * `shasum -a 256 -c <asset>.sha256` works in the folder the asset was downloaded to — not `dist/<asset>`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = join(import.meta.dirname, "..", "scripts", "checksum.mjs");

/** The platform's own checker, if it has one: `sha256sum -c` (GNU, Git Bash) or `shasum -a 256 -c` (macOS, Perl). */
function platformCheck(cwd: string, file: string): { tool: string; code: number | null; output: string } | null {
  for (const [tool, args] of [["sha256sum", ["-c", file]], ["shasum", ["-a", "256", "-c", file]]] as const) {
    const result = spawnSync(tool, args, { cwd, encoding: "utf8" });
    if (result.error) continue; // not installed here
    return { tool, code: result.status, output: `${result.stdout}${result.stderr}` };
  }
  return null;
}

test("a release .sha256 is one line, `<hex>  <basename>`, and checks next to a downloaded asset", () => {
  const work = mkdtempSync(join(tmpdir(), "ap-checksum-"));
  try {
    // Built under dist/ as release.yml does, from the repository root.
    mkdirSync(join(work, "dist"));
    const asset = "airprompter-linux-x64";
    const bytes = Buffer.from("not really an executable\n");
    writeFileSync(join(work, "dist", asset), bytes);
    const result = spawnSync(process.execPath, [script, join("dist", asset)], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const hex = createHash("sha256").update(bytes).digest("hex");
    const written = readFileSync(join(work, "dist", `${asset}.sha256`), "utf8");
    assert.equal(written, `${hex}  ${asset}\n`, "the bare name: no dist/ prefix, no * marker, one LF-terminated line");
    assert.equal(result.stdout, written);

    // A user's downloads folder: the asset and its .sha256, nothing else.
    const downloads = join(work, "downloads");
    mkdirSync(downloads);
    writeFileSync(join(downloads, asset), bytes);
    writeFileSync(join(downloads, `${asset}.sha256`), written);
    const check = platformCheck(downloads, `${asset}.sha256`);
    if (check) {
      assert.equal(check.code, 0, `${check.tool} -c: ${check.output}`);
      assert.match(check.output, new RegExp(`${asset}: OK`));
      // And it is a real check: a changed asset fails it.
      writeFileSync(join(downloads, asset), Buffer.from("tampered\n"));
      assert.notEqual(platformCheck(downloads, `${asset}.sha256`)!.code, 0, "a changed asset fails the check");
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("checksum.mjs refuses a missing asset with usage (2) and writes nothing", () => {
  const work = mkdtempSync(join(tmpdir(), "ap-checksum-"));
  try {
    const result = spawnSync(process.execPath, [script, "nope"], { cwd: work, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: checksum\.mjs <asset>/);
    assert.deepEqual(readdirSync(work), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
