# n8n node: live run for QA

This folder is not published to npm. `scripts/live-n8n.mjs` runs the AirPrompter node in a real, headless n8n
against a live AirPrompter, and checks what n8n got back. A QA test sets up the agent, calls the script, and then
checks the agent's Metrics. This page says how to do each step.

## What it proves

All three runs happen in n8n 2.49.8, with the package installed as a self-hosted user installs it:

1. **A counted run.** Get Prompt serves the approved, promoted version from a signed manifest that the node
   verified. The workflow continues with a model stub that reports 123 input and 7 output tokens, then Report Run
   with thumbs up. AirPrompter accepts the report.
2. **An uncounted run.** A Get Prompt with no Report Run is not counted.
3. **The stored copy.** Get Prompt runs with every outbound request blocked, so neither AirPrompter nor its edge
   can answer. It serves the same version from the copy that the first run stored in n8n's user folder.

The QA test adds what the script cannot see: the agent's Metrics show exactly one run for that version.

## What it needs

- **Node 22.19 or later, and npm.** The node itself runs on Node 20; the test dependencies (undici 8) need 22.19. It needs network access to `api.airprompter.dev` and `registry.npmjs.org`.
- **n8n 2.49.8.** Install it once and point `N8N_BIN` at it, so a run does not download n8n:
  `npm i n8n@2.49.8` in a cache folder, then `N8N_BIN=<that folder>/node_modules/.bin/n8n`. Without `N8N_BIN`, the
  script uses `npx --yes n8n@2.49.8`. The `n8n.version` check fails on any other version, unless you pass
  `--any-n8n`.
- **This package's dev dependencies:** `npm ci --legacy-peer-deps` in `integrations/n8n`.
- **A dev agent.** A Team owner creates it, for QA the per-run owner in its disposable organization, with the
  console's own API calls:

  | Step | Call (owner's console session) |
  |---|---|
  | 1. Approve a prompt version with one variable | Import `Route this ticket: {{ticket}}` with a per-run marker, then approve the version through the workspace's required lifecycle steps |
  | 2. Create the agent | `POST /workspace/{ws}/agents` `{ "name": … }` |
  | 3. Attach the slot | `POST /workspace/{ws}/agents/{agent}/slots` `{ "kind": "prompt", "artifactId": <prompt>, "displayName": "Ticket triage", "tag": "triage", "variables": [{ "name": "ticket", "required": true, "trust": "operator" }] }` |
  | 4. Mint the Update key | `POST /workspace/{ws}/agents/{agent}/keys` `{ "target": "dev", "kind": "agent", "label": "QA n8n" }`. Read `secret` (`apa_…`) from this one answer. |
  | 5. Seal a release | `POST /workspace/{ws}/agents/{agent}/releases` `{ "environment": "dev", "pins": [{ "tag": "triage", "versionId": <version>, "model": "gpt-5-mini" }] }`, after a `dryRun: true` preview, acknowledging any warnings it flags |
  | 6. Promote it | `POST /workspace/{ws}/agents/{agent}/environments/dev/promote` `{ "releaseDigest": …, "expectedStateRevision": … }`. Read `board.environments.dev.stateRevision` from `GET /workspace/{ws}/agents/{agent}/board`. |


## Run it

```bash
cd integrations/n8n
AIRPROMPTER_AGENT_ID=<agent> AIRPROMPTER_UPDATE_KEY=<apa_…> AIRPROMPTER_ENVIRONMENT=dev AIRPROMPTER_SLOT=triage \
N8N_BIN=<cache>/node_modules/.bin/n8n node scripts/live-n8n.mjs > live-n8n.json
```

- **Defaults:** `AIRPROMPTER_API_URL=https://api.airprompter.dev`, `AIRPROMPTER_DEPLOYMENT=dev` (this version pins
  the dev root), `AIRPROMPTER_VARIABLES={"ticket":"Refund for order 1042 has not arrived"}` and
  `AIRPROMPTER_SUBJECT=qa-n8n-subject-1`. The fixed subject puts every run on the same A/B arm.
- **The Update key** is read from the environment only. The script never prints it. It deletes its temporary
  folder, including the n8n database that holds the credential, on exit and on Ctrl-C.
- **Time:** about one to two minutes on a loaded machine. The build and install take about 30 seconds, and the two
  n8n boots 10 to 30 seconds each.
- **Output:** one JSON line on stdout, every time. PASS and FAIL lines go to stderr.
- **Exit codes:** 0 when every check passed; 1 when a check failed or n8n could not run (`error` says why); 2 for
  bad input; 130 when interrupted.

The JSON fields a test reads:

```json
{
  "ok": true, "exitCode": 0, "startedAt": "…", "finishedAt": "…",
  "agentId": "agent_…", "environment": "dev", "slot": "triage", "subject": "qa-n8n-subject-1",
  "n8nVersion": "2.49.8", "sdkVersion": "1.0.0-rc.4",
  "getPrompt": { "versionId": "…", "arm": "none", "generation": 1, "model": "gpt-5-mini", "servedFrom": "network", "leaseExpiresAt": "…" },
  "reported": { "runRef": "…", "inputTokens": 123, "outputTokens": 7, "thumbs": "up" },
  "expected": { "runs": 1, "inputTokens": 123, "outputTokens": 7, "thumbsUp": 1, "versionId": "…", "arm": "none" },
  "notCounted": ["<runRef of the unreported Get Prompt>", "<runRef of the stored-copy Get Prompt>"],
  "checks": [{ "id": "get_prompt.network", "name": "…", "state": "pass" }, …]
}
```

Check ids, which are stable: `n8n.version`, `workflow.get_and_report`, `get_prompt.network`,
`get_prompt.run_ref`, `report_run.accepted`, `release.stored`, `get_prompt.unreported`, `get_prompt.stored_copy`.

## What to assert

1. **The script:** exit 0, `ok: true`, and every check `pass`.
2. **The served version:** `getPrompt.versionId` is the version approved in step 1, and `getPrompt.servedFrom` is
   `network`.
3. **Metrics:** call `GET /workspace/{ws}/agents/{agent}/metrics?environment=dev&range=24h&tag=triage`
   with the owner's session.
   - **Poll it.** The rollup runs every 5 minutes, so poll every 30 seconds until `tiles.runs >= 1`, for up to 20
     minutes. On dev on 2026-11-27 the run appeared 4.5 minutes after Report Run. A
     `503 agent_telemetry_correction_pending` answer means retry.
   - **Then assert, all from the one response.** The agent is fresh, so this is not a before-and-after count.
     - `tiles.runs === expected.runs`, which is 1.
     - `tiles.tokensIn === 123` and `tiles.tokensOut === 7`.
     - `rows` holds exactly one entry, and that entry has:
       - `versionId === expected.versionId`;
       - `arm === expected.arm` (`none` without an A/B test);
       - `runs === 1`;
       - `feedback.good === 1`, the thumbs up.
   - **What the count proves:** the Get Prompt with no Report Run and the stored-copy Get Prompt (`notCounted`)
     must not add runs. The count stays 1.
   - In the console, this is **Agents › the agent › Metrics**, environment Development, slot `triage`.

**Test timeout:** about 25 minutes. That is about 2 for the script, up to 20 for Metrics, and headroom. Each n8n
call inside the script is limited to 10 minutes.

If `report_run.accepted` fails, `expected.runs` is `null`. A Report Run that timed out may still have been
recorded, so read Metrics before running the script again.
