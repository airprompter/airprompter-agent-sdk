/**
 * Copies the node icons next to the compiled nodes: n8n resolves `file:airprompter.svg` relative to the node's
 * `.node.js`, and `tsc` copies only TypeScript.
 *
 *   $ node scripts/copy-icons.mjs        # after tsc; `npm run build` runs both
 */
import { cpSync, readdirSync } from "node:fs";
import { join } from "node:path";

for (const dir of readdirSync("nodes")) {
  for (const file of readdirSync(join("nodes", dir)).filter((name) => name.endsWith(".svg"))) {
    cpSync(join("nodes", dir, file), join("dist", "nodes", dir, file));
  }
}
