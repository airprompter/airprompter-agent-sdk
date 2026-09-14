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
  // The SDK packages by source (S10): the binary is built from the packages' sources, never from a published dist.
  alias: {
    "@airprompter/agent-core/testing": join(root, "..", "sdk-typescript", "packages", "core", "src", "testing", "index.ts"),
    "@airprompter/otel-bridge": join(root, "..", "sdk-typescript", "packages", "otel-bridge", "src", "index.ts"),
    ...Object.fromEntries(["core", "sync", "runtime", "telemetry", "sdk"].map((name) => [`@airprompter/agent-${name}`, join(root, "..", "sdk-typescript", "packages", name, "src", "index.ts")])),
  },
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: join(root, "dist", "airprompter.cjs"),
  define: {
    __AIRPROMPTER_CLI_VERSION__: JSON.stringify(pkg.version),
    __AIRPROMPTER_PROTOCOL_VERSION__: JSON.stringify(readFileSync(join(root, "..", "protocol", "VERSION"), "utf8").trim()),
    "import.meta.url": "__airprompter_import_meta_url",
  },
  banner: { js: "#!/usr/bin/env node\nconst __airprompter_import_meta_url = require('url').pathToFileURL(__filename).href;" },
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "info",
});
chmodSync(join(root, "dist", "airprompter.cjs"), 0o755);
