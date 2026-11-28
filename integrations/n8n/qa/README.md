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

- **Node 24 or later for n8n, and npm** (npm only for the default, packing run; see "Offline"). n8n 2.49.8 itself
  requires Node 24. The kit runs on Node 20.1 or later. It needs network access to `api.airprompter.dev`, and to `registry.npmjs.org` except in the offline mode.
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


## Offline: a CI image that must not reach npm at test time

The default run builds the package, packs it and runs `npm install`, so it needs the npm registry. A remote run that
must not reach the registry splits this in two. It saves the ~30 s build and install on every run too.

### At image build time (network allowed)

Prepare the community-nodes folder once, from the commit the test pins:

```bash
cd integrations/n8n && npm ci --legacy-peer-deps
AIRPROMPTER_KIT_COMMIT=<pinned sha> node scripts/live-n8n.mjs --prepare-nodes-dir /opt/airprompter/n8n-nodes
```

- **What it writes:**
  - `node_modules/n8n-nodes-airprompter`, with the SDK under it (about 3.5 MB);
  - `airprompter-kit.json`: package and SDK versions, the tarball's sha256, a `contentSha256` over all of
    `node_modules`, the commit, and `preparedAt`.
- **The target** must be empty or new. The kit installs into a sibling folder and renames it at the end, so a failed
  build can simply be retried.
- **The commit is required.** It comes from git when this is a clean checkout of the repository, or from
  `AIRPROMPTER_KIT_COMMIT` for a copy without `.git`. A Docker build context usually has no `.git`, so pass the sha
  as `ARG`/`--build-arg` and set the variable.
  - If both exist, they must agree.
  - A tree with uncommitted changes to tracked files under `integrations/n8n` is refused, and so is an untracked
    build input (`src`, `nodes`, `credentials`, the package files, `tsconfig.json`, `README*`, `LICENSE*`, `LICENCE*`). Other
    untracked files are ignored.
  - `AIRPROMPTER_KIT_COMMIT` must be the full 40-character sha, lowercase, as `git rev-parse` prints it.
  - `--no-build` is refused: prepare always builds.
- **Install n8n with Node 24's own npm** (`PATH=/opt/node24/bin:$PATH npm i n8n@2.49.8 --prefix /opt/n8n`), so its
  native add-ons are built for Node 24.
- **The N8N_BIN wrapper.** Make `/opt/n8n/n8n` (mode 755) a two-line file:

  ```sh
  #!/bin/sh
  PATH=/opt/node24/bin:$PATH exec node /opt/n8n/node_modules/n8n/bin/n8n "$@"
  ```

  - **Not `node_modules/.bin/n8n`:** its `#!/usr/bin/env node` picks up the image's default Node.
  - **The `PATH` line** also gives n8n's JS task runner Node 24, because n8n starts it as `node` from `PATH`.
  - **Keep the environment as it is (no `env -i`):** the stored-copy run passes `NODE_OPTIONS=--require …` through
    the wrapper.

### At test time (only AirPrompter reachable)

```bash
cd integrations/n8n
N8N_BIN=/opt/n8n/n8n AIRPROMPTER_KIT_COMMIT=<pinned sha> AIRPROMPTER_AGENT_ID=… AIRPROMPTER_UPDATE_KEY=… \
  node scripts/live-n8n.mjs --nodes-dir /opt/airprompter/n8n-nodes
```

- **No npm at all.** The run does no build, pack, install or `npx`, and does not need `npm ci`. The kit uses only
  Node's built-in modules, so test time needs Node 20.1 or later and the checkout.
  - **The copy:** the prepared folder is copied into the run's fresh user folder, and n8n runs with
    `npm_config_offline=true`.
  - **`N8N_BIN` is required:** without it, the run exits 2 rather than reach the registry through `npx`.
  - **The folder can also come from `AIRPROMPTER_KIT_NODES_DIR`**, which means the same as `--nodes-dir`. The old
    name `N8N_NODES_DIR`, or a blank value, exits 2 rather than fall back to npm.
- **`scripts/` and `qa/workflows/` are read from the checkout the script runs from.** Bake that checkout into the
  image from the same commit, in the same layer as the prepare step.
- **The `nodes.prepared` check compares the copy with the prepared folder:**
  - its content hash (nothing changed after prepare);
  - the package and SDK versions, and the checkout's `package.json` version;
  - the commit, exactly, as a full 40-character sha: against `AIRPROMPTER_KIT_COMMIT` and against the checkout's
    own when it is a git checkout. Each is used when known. With neither, the check fails, so set
    `AIRPROMPTER_KIT_COMMIT` to your pin.
- **If `nodes.prepared` fails, the run stops before n8n.** Nothing is sent to AirPrompter.
- **The summary adds:**

  ```json
  "nodes": { "mode": "preinstalled", "from": "/opt/airprompter/n8n-nodes", "checkoutCommit": null,
             "kit": { "package": "n8n-nodes-airprompter", "packageVersion": "0.1.0", "sdkVersion": "1.0.0-rc.5",
                      "tarballSha256": "…", "contentSha256": "…", "commit": "<sha>", "preparedAt": "…" } }
  ```

  Assert `nodes.mode === "preinstalled"` and that `nodes.prepared` is `pass`, along with the other checks.

### Smoke at image build time

`scripts/live-n8n-smoke.mjs` runs the kit against the SDK's fake control plane on loopback, with one promoted slot
`triage` (`Route this ticket: {{ticket}}`, trust `operator`). It needs no AirPrompter and no network, so a broken
n8n, wrapper or prepared folder fails the image build instead of a QA run.

```bash
cd integrations/n8n   # its npm ci --legacy-peer-deps already ran: the fake plane is @airprompter/agent-sdk/testing
N8N_BIN=/opt/n8n/n8n AIRPROMPTER_KIT_COMMIT=<pinned sha> node scripts/live-n8n-smoke.mjs --nodes-dir /opt/airprompter/n8n-nodes
```

- **Where it runs:** in the same image stage as `npm ci --legacy-peer-deps` and the prepare step, while
  `integrations/n8n/node_modules` is still there. The fake plane is `@airprompter/agent-sdk/testing`.
- **Requirements:** it needs `N8N_BIN` and exits 2 without it. With `--nodes-dir` it needs no network; other
  arguments pass through to the kit.
- **It passes only when:**
  - the kit exits 0 with every check `pass` and none skipped, including `get_prompt.rendered`, whose expected
    sha256 the smoke sets;
  - with `--nodes-dir`, the prepared folder was used (`nodes.mode`);
  - Get Prompt served `ver_smoke` from the network;
  - the fake plane received exactly one `ok` run on `ver_smoke`, with 123 input and 7 output tokens, and one thumbs
    up.
- **Output:** one JSON line every time. It is the kit's line with `ok` and `exitCode` set to the smoke's verdict,
  plus a `smoke` object (`expectedPromptSha256`, `delivered`, `problems`, `kitExitCode`).
- **Exit codes:** 0 or 1. 2 means bad input: no `N8N_BIN`, a `SMOKE_TIMEOUT_MS` that is not a positive whole
  number, or the kit's own bad input. 130 or 143 means interrupted, after the kit has stopped.
- **Stopping it:** signal the smoke process itself, not its process group. The kit runs in a group of its own, and
  the smoke forwards the signal there and waits for it.
- **Timeout:** `SMOKE_TIMEOUT_MS` (default 15 minutes) stops the kit's whole process group if it hangs: SIGTERM, then
  SIGKILL 15 s later.
- **Trust root:** the fake plane signs with its own root, so this step does not exercise the pinned dev root. The
  live run does.
- **Time:** about 30 to 60 s. Peak memory for the whole tree (kit, n8n, task runner) was about 570 MB on
  2026-11-27.

### Offline errors

| What | Exit | Message starts |
|---|---|---|
| `--nodes-dir` without `N8N_BIN` | 2 | `--nodes-dir runs offline and needs N8N_BIN` |
| `--nodes-dir` folder without `airprompter-kit.json`, or never prepared | 2 | `… has no airprompter-kit.json: make it with --prepare-nodes-dir` |
| A flag without its value, an unknown flag, both modes | 2 | `--nodes-dir needs a folder` / `unknown argument …` |
| `N8N_BIN` runs n8n on Node below 24 | 1 | `N8N_BIN runs n8n on a Node older than it accepts` |
| `N8N_BIN` missing, not executable, or no shebang | 1 | `n8n did not start: …` (`ENOENT`, `EACCES`, `ENOEXEC`) |
| The prepared folder changed, a commit or version differs, or no commit to compare | 1 | check `nodes.prepared` fails, with `detail`; n8n is not started |
| `AIRPROMPTER_KIT_COMMIT` that is not a full 40-character sha | 2 | `AIRPROMPTER_KIT_COMMIT must be a full 40-character commit sha` |
| `AIRPROMPTER_EXPECTED_PROMPT_SHA256` that is not 64 lowercase hex | 2 | `AIRPROMPTER_EXPECTED_PROMPT_SHA256 must be a sha256 in lowercase hex` |

`--prepare-nodes-dir` prints one JSON line of its own: `{ok, exitCode, nodesDir, kit}`, or `{ok: false, exitCode,
nodesDir, error}`.
- **Exit 2:** a folder that is not empty, no commit, a modified tree, `--no-build`, or both commits given and
  different.
- **Exit 1:** the npm build, pack or install failed. It is synchronous, so an interrupt also ends it with exit 1.

**Node.** n8n 2.49.8 refuses anything below 24: its launcher checks its `engines` (`>=24.0.0`) and exits. It
answers `--version` before that check, so the kit probes with `--help` too. The kit itself runs on Node 20.1 or
later. An image whose default Node is older carries a Node 24 binary for n8n alone, behind the wrapper above.

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
  "n8nVersion": "2.49.8", "sdkVersion": "1.0.0-rc.5",
  "getPrompt": { "promptSha256": "…", "promptBytes": 54, "versionId": "…", "arm": "none", "generation": 1, "model": "gpt-5-mini", "servedFrom": "network", "leaseExpiresAt": "…" },
  "reported": { "runRef": "…", "inputTokens": 123, "outputTokens": 7, "thumbs": "up" },
  "expected": { "runs": 1, "inputTokens": 123, "outputTokens": 7, "thumbsUp": 1, "versionId": "…", "arm": "none" },
  "notCounted": ["<runRef of the unreported Get Prompt>", "<runRef of the stored-copy Get Prompt>"],
  "checks": [{ "id": "get_prompt.network", "name": "…", "state": "pass" }, …]
}
```

Check ids, which are stable: `nodes.prepared` (only with `--nodes-dir`), `get_prompt.rendered` (only with
`AIRPROMPTER_EXPECTED_PROMPT_SHA256`), `n8n.version`, `workflow.get_and_report`, `get_prompt.network`,
`get_prompt.run_ref`, `report_run.accepted`, `release.stored`, `get_prompt.unreported`, `get_prompt.stored_copy`.

## What to assert

1. **The script:** exit 0, `ok: true`, and every check `pass`.
2. **The served version:** `getPrompt.versionId` is the version approved in step 1, and `getPrompt.servedFrom` is
   `network`.
   - **The served text:**
     - **`getPrompt.promptSha256`** is the sha256, in lowercase hex, of the exact prompt string the node returned in
       the counted (network) run, as UTF-8 bytes. It is taken with no trimming and no newline changes.
     - **`getPrompt.promptBytes`** is that string's length in bytes.
     - **The text itself** is not in the summary.
     - **Null:** both are `null` if no prompt was served.
     - **Stored copy:** the `get_prompt.stored_copy` check also requires the stored-copy run to render the same
       text.
   - **Expected value:** start from the approved version's text as AirPrompter holds it, marker included. Read it
     back from the version rather than reusing the string you imported. Replace each `{{ticket}}`, spaces inside
     the braces allowed, with its value from `AIRPROMPTER_VARIABLES`, exactly as given. That holds for a variable of
     trust `operator`, as in step 3 of the fixture.
     - **An `end_user` variable** is rendered inside a delimiter the SDK adds (`<ticket>…</ticket>`, see
       `docs/variables.md`), so keep the fixture's variables `operator` for this assertion.
   - **Let the kit check it:** set `AIRPROMPTER_EXPECTED_PROMPT_SHA256` to that sha256, and the kit adds a
     `get_prompt.rendered` check. A mismatch is then a failing check with both hashes in its `detail`.
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

**Stopping it:** the script waits on n8n synchronously, so on a timeout, kill its whole process group, not just the
script. Otherwise the n8n step in progress runs to its end, and a Report Run may still be recorded. Read Metrics
before running it again.

**Test timeout:** about 25 minutes. That is about 2 for the script, up to 20 for Metrics, and headroom. Each n8n
call inside the script is limited to 10 minutes.

If `report_run.accepted` fails, `expected.runs` is `null`. A Report Run that timed out may still have been
recorded, so read Metrics before running the script again.
