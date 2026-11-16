# n8n-nodes-airprompter

n8n community nodes for **AirPrompter Agents**. A workflow step gets the prompt version that was approved and signed
in AirPrompter for a *slot*, then runs it on n8n's own model nodes (OpenAI, Anthropic, Gemini, the AI Agent).
No model ever runs on AirPrompter.

- **AirPrompter** › **Get Prompt** renders the approved version of one slot with the step's variables. It returns
  the prompt text, the model and inference settings the version pins, the slot, version, A/B arm and a `runRef`.
- **AirPrompter** › **Report Run** sends how the run went: input and output tokens (read from the model node's
  output), the error class, and thumbs or a 1–5 rating, all keyed by that `runRef`.
- **AirPrompter Trigger** (polling) emits one item for each rollout change: a new version approved, a dial-up step,
  an A/B test started or ended, a rollback, or a slot disabled or enabled.

**AirPrompter controls the rollout.** Versions, approvals, A/B arms, dial-up percentages, rollback and the lease are
all set in AirPrompter, and none of them can be changed in n8n. A step only picks a slot, fills its variables and
can name a **Subject**.

> Status: not yet published to npm and not verified by n8n (see [n8n verification](#n8n-verification)). The package
> targets **self-hosted n8n**.

## Install (self-hosted)

Until the package is on npm, build it from this repository and load it as a custom extension:

```bash
cd sdk-typescript && npm ci && npm run build && cd ..
cd integrations/n8n && npm ci --legacy-peer-deps && npm run build
N8N_CUSTOM_EXTENSIONS="$PWD" npx n8n start
```

Once it is published: **Settings › Community Nodes › Install** › `n8n-nodes-airprompter`.

## Credentials

Create an **AirPrompter Agent API** credential:

| Field | What to enter |
|---|---|
| Agent ID | The agent in AirPrompter that holds the slots. |
| Update Key | The agent's Update key (key kind "agent", bound to one agent and one environment). It reads approved releases and nothing more. |
| Environment | The environment the key is bound to, such as `prod`. |
| Root Public Key | AirPrompter's root public key (a JSON Web Key) for the deployment. Every release is verified against it before it is stored or used. This field goes away once the key is pinned in the SDK's Steps core (`HOSTED_ROOTS` in `sdk-typescript/packages/sdk/src/frameworks/steps/trust.ts`). |
| API Base URL | `https://api.airprompter.com` by default. For testing, use a dev URL or a local `airprompter dev` registry. |
| AirPrompter Deployment | The deployment that signs the releases: `prod`, `staging` or `dev`. This is not the agent's environment. |
| Root Document URL | Optional. Defaults to *API Base URL*`/roots/<deployment>/root.json`. |
| Organization ID | Optional. It is learned from the first verified release. |
| Keep the Stored Copy In | **n8n User Folder** (self-hosted) or **Workflow Static Data** (no disk). See [Where the release is kept](#where-the-release-is-kept). |
| Starting Bundle Path | Optional, user folder only. A `.apbundle` to serve from before AirPrompter has ever been reached. |

The credential test fetches the signed manifest and **verifies** it. A wrong key, the wrong environment or the wrong
root key each fail the test with the reason.

## Using it

```text
Webhook ─▶ AirPrompter: Get Prompt ─▶ OpenAI: Message a Model ─▶ AirPrompter: Report Run
           slot: support.triage         model:  {{ $json.model }}      Run Reference:
           ticket: {{ $json.body }}     prompt: {{ $json.prompt }}     {{ $('AirPrompter').item.json.runRef }}
           Subject: {{ $json.userId }}  temperature: {{ $json.inference.temperature }}
                                                                        Token Usage: Detect From Input Item
```

**Get Prompt** output:

```json
{
  "prompt": "Triage this ticket: …",
  "model": "gpt-5-mini",
  "inference": { "temperature": 0.2, "maxOutputTokens": 400 },
  "slot": "support.triage",
  "versionId": "ver_7",
  "arm": "candidate",
  "generation": 12,
  "runRef": "…",
  "servedFrom": "network",
  "leaseExpiresAt": "2026-11-16T22:00:00.000Z"
}
```

- The **Slot** list and the **Variables** fields come from the approved release. The variables are the union across
  A/B arms, so the step can fill whichever version the split assigns. Values for variables that the served version
  does not declare are ignored.
- **Subject** keeps one customer, ticket or user on one A/B arm across runs. The value is hashed on the n8n side and
  is never sent to AirPrompter. Leave it empty to assign each run at random by the signed weights. Dial-up follows
  the signed ramp on n8n's own clock, and needs no new release.
- `servedFrom` is `network` when AirPrompter answered during this step. It is `stored` when AirPrompter could not be
  reached and the stored copy was served.

**Report Run**: set *Token Usage* to **Detect From Input Item** to read usage from the model node's output. It
recognises these shapes:

- OpenAI: `usage.prompt_tokens` and `usage.completion_tokens`, or `usage.input_tokens`
- Anthropic
- Gemini: `usageMetadata`
- LangChain: `tokenUsage` and `usage_metadata`
- Bedrock

Alternatively, choose **Map Fields**. Only counts and an error *class* are sent; prompt text, model output and the
error message stay in n8n. Report each `runRef` once, because the report is the run's only count. A Get Prompt with
no Report Run is not counted today.

If AirPrompter is unreachable, the report fails with a retryable error and nothing is recorded. Turn on **Retry On
Fail** for the Report Run node.

## Where the release is kept

The node keeps the signed release (manifest and payloads) on the n8n side, in the SDK's shared datastore format
(`protocol/datastore-format.md`). Each copy is sealed to an X25519 key derived from the Update key, so the stored
copy is ciphertext. Every step does the following:

1. Pulls from AirPrompter if anything changed (ETag or edge pointer).
2. Starts a fresh SDK agent that loads the stored copy and **verifies it again**: the root, the signature, the scope
   and every payload hash. A tampered copy is refused.
3. Serves it.

While AirPrompter is unreachable, the stored copy is served for the manifest's `leaseSeconds`, counted from the last
time AirPrompter answered. After that, the step fails with `lease_expired` (retryable) until AirPrompter answers
again.

| Hosting | Storage | Limits |
|---|---|---|
| Self-hosted (default) | `N8N_USER_FOLDER/.n8n/airprompter/<agent>/<environment>/releases` (`~/.n8n/...` without the variable) | All workflows on the instance share it. It is written by one process at a time (an atomic rename per file). In **queue mode**, each worker needs this folder on a shared volume, or each worker keeps its own copy. |
| No disk (*Workflow Static Data*) | The workflow's static data under the key `airprompter` | n8n saves static data **only after production executions** (an active workflow started by its trigger, schedule or webhook), never after a manual test run. Each workflow keeps its own copy. The data is stored in n8n's database next to the workflow, so it holds at most two releases. Two executions that run at the same time each save, and the later save wins. This is harmless because rows are immutable and verified on load. |
| Fully offline | *Starting Bundle Path*: a plaintext `.apbundle` (`airprompter pull --plaintext`, dev environment) is copied into an empty stored copy | It is verified like any other release and serves within its manifest's lease, counted from when the manifest was issued. Export it with a lease that covers the offline period. A bundle sealed to another key cannot be read. |

**n8n Cloud.** A custom node *can* call `getWorkflowStaticData` from `execute`, `poll` and load-options methods (it is
on `FunctionsBase` in `n8n-workflow`), so static data is the storage that needs no disk. **Data tables** were
considered and not used for three reasons:

- Their helpers (`getDataTableProxy`) are not available to polling triggers.
- They require the user to create a table first.
- They are scoped to a project.

Their advantage would be persisting after manual runs. However, n8n Cloud installs only **verified** community nodes,
and this package cannot be verified as built (next section). The no-disk mode therefore matters today for
containers without a persistent volume.

**Telemetry.** Each Report Run sends its rows synchronously, under its own upload grant. Nothing is spooled on disk.

## n8n verification

n8n's [verification guidelines](https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/)
and its linter (`npm run lint:cloud`) refuse four things this package needs or has by design:

1. **Runtime dependencies.** The package depends on `@airprompter/agent-sdk`, which holds the trust chain (signature
   and hash verification), the sealed store, the A/B assignment and the run reference. Re-implementing that inside
   the node would fork the protocol. Bundling the SDK into `dist` would remove the dependency entry, but not the
   next two points.
2. **File system and environment access.** This covers the user-folder storage and `N8N_USER_FOLDER`. The SDK
   itself also uses `node:fs`, a temporary store per call and `process.env`.
3. **Restricted globals.** `setTimeout`, used for request timeouts, and `process`.
4. **License.** n8n requires MIT. This repository is BSD-3-Clause.

`npm run lint` runs n8n's own rule set for packages that do not target n8n Cloud (`@n8n/node-cli`'s
`configWithoutCloudSupport`), with only the licence and dependency rules relaxed. It passes.

## How it is built

- The platform-agnostic client is the SDK's Steps subpath, `@airprompter/agent-sdk/frameworks/steps`, shared with
  the Zapier app (AIR-2405): `createAutomationClient`, the rollout diff behind the trigger, trust, the KvStore
  datastore with its notes, vendored-bundle seeding (`seedDatastoreFromBundle`) and usage detection (`usageFrom`).
  This package imports the SDK only through that subpath; the SDK's `npm run lint:imports` enforces it. The core's
  tests live in the SDK (`sdk-typescript/test/frameworks/steps/`).
- `src/n8n/`: everything n8n-specific:
  - storage (`fsKvStore` in the user folder, `staticDataKvStore`)
  - reading a vendored bundle from the credential's path
  - the poll state (baseline on the first poll, deduplication by event id)
  - error mapping to `NodeOperationError`
- `nodes/`, `credentials/`: the node and credential descriptions.

Report Run is the run's one count: the Steps core calls the SDK's `ap.reportRun`. Get Prompt renders outside any
run and writes no run row.

## Develop

```bash
cd sdk-typescript && npm ci && npm run build && cd ../cli && npm ci && cd ../integrations/n8n
npm ci --legacy-peer-deps
npm run typecheck && npm run lint && npm test
```

The tests use mocked n8n contexts (execute, poll, load options, credential test) against the SDK's fake control plane
over loopback HTTP, plus the fully offline install from a vendored bundle. The Steps core's own tests, including
one that runs `airprompter dev <directory>` from `cli/` as its own process, are in the SDK.
