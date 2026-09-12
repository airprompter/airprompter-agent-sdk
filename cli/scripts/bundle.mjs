#!/usr/bin/env node
// One CommonJS file from src/main.ts and the SDK sources it imports, with
// the version stamped in. This is the input to the single-executable build
// and, on its own, `node dist/airprompter.cjs`.

import { build } from "esbuild";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
mkdirSync(join(root, "dist"), { recursive: true });

await build({
  entryPoints: [join(root, "src", "main.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: join(root, "dist", "airprompter.cjs"),
  banner: { js: "#!/usr/bin/env node" },
  define: { __AIRPROMPTER_CLI_VERSION__: JSON.stringify(pkg.version) },
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "info",
});
chmodSync(join(root, "dist", "airprompter.cjs"), 0o755);
