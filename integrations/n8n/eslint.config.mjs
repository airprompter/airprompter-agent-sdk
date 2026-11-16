// n8n's own lint rules for community nodes (`@n8n/node-cli`, the rules `n8n-node lint` runs), with three
// exceptions, each a product decision explained in README › "n8n verification":
//   - the licence stays BSD-3-Clause (the repository's), not MIT;
//   - the package depends on @airprompter/agent-sdk (verification, signing, the encrypted store live there);
//   - src/core imports nothing from n8n by design (it is shared with other automation platforms), so it throws its
//     own AutomationError; the nodes turn it into NodeOperationError (src/n8n/errors.ts).
//
//   $ npm run lint            # self-hosted rules, the gate this package keeps
//   $ npm run lint:cloud      # n8n Cloud's stricter rules, for the record: they refuse any dependency, process, fs
import { config, configWithoutCloudSupport } from "@n8n/node-cli/eslint";

const base = process.env.N8N_LINT_CLOUD ? config : configWithoutCloudSupport;

export default [
  ...base,
  {
    files: ["package.json"],
    rules: {
      "n8n-nodes-base/community-package-json-license-not-default": "off",
      "@n8n/community-nodes/no-runtime-dependencies": process.env.N8N_LINT_CLOUD ? "error" : "off",
    },
  },
  {
    files: ["src/core/**/*.ts", "src/n8n/connect.ts"],
    rules: { "@n8n/community-nodes/require-node-api-error": "off" },
  },
];
