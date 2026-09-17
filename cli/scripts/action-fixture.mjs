#!/usr/bin/env node
// A fixture for the verify action's CI step (S14): a plaintext bundle the
// fake control plane sealed and the pinned root it verifies against, written
// to the directory given, with the action's inputs on GITHUB_OUTPUT.
//
//   $ node scripts/action-fixture.mjs <dir>
//
// Runs the TypeScript sources through tsx (a devDependency of the CLI) so
// the fixture is the same one cli/test/action.test.ts uses.

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(process.argv[2] ?? "action-fixture");
mkdirSync(dir, { recursive: true });

const sdk = (rel) => JSON.stringify(pathToFileURL(join(root, "..", "sdk-typescript", rel)).href);
const script = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPlaintextBundle } from ${sdk("packages/core/src/bundle/apbundle.ts")};
import { publicJwkOf } from ${sdk("packages/core/src/protocol/trust.ts")};
import { FakeControlPlane } from ${sdk("test/helpers/controlPlane.ts")};
const scope = { organizationId: "org_ci", agentId: "agt_ci", target: "prod" };
const plane = new FakeControlPlane(scope);
plane.promote([plane.slot({ tag: "support.reply", text: "Reply warmly {{name}}", variables: [{ name: "name", required: false, trust: "operator" }] })]);
const bundle = createPlaintextBundle({ createdAt: new Date().toISOString(), notAfter: "2027-01-01T00:00:00Z", manifest: plane.manifest, keySet: plane.root, payloads: [...plane.payloads].map(([contentHash, bytes]) => ({ contentHash, byteLength: bytes.length, bytes: bytes.toString("base64url") })) });
writeFileSync(join(process.argv[2], "prod.apbundle"), JSON.stringify(bundle));
writeFileSync(join(process.argv[2], "root.jwk.json"), JSON.stringify(publicJwkOf(plane.rootKey)));
console.log(JSON.stringify(scope));
`;
const entry = join(dir, "make.mts");
writeFileSync(entry, script);
const made = spawnSync(process.execPath, ["--import", "tsx", entry, dir], { cwd: root, encoding: "utf8" });
if (made.status !== 0) {
  console.error(made.stderr);
  process.exit(made.status ?? 1);
}
const scope = JSON.parse(made.stdout.trim().split("\n").pop());
const outputs = { bundle: join(dir, "prod.apbundle"), root: join(dir, "root.jwk.json"), org: scope.organizationId, agent: scope.agentId, environment: scope.target };
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(""));
console.log(JSON.stringify(outputs));
