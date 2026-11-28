# Examples

## One agent per framework

Each framework example builds the same support agent: one tool,
`lookup_order`, on the slot `support.reply`, whose approved prompt is
[`prompts/support/reply.md`](prompts/support/reply.md). Only the framework
lines differ, so the examples compare side by side. Copy the folder for your
framework and `prompts/` beside it, or clone this repository. Its README
starts a local registry with `airprompter dev ../prompts`, so it runs with
no AirPrompter account, and its last section says what to change for a real
agent.

| Folder | Framework | Shows |
| -- | -- | -- |
| [`langchain-typescript/`](langchain-typescript/) | LangChain (`langchain`, TypeScript) | `airprompter(ap, { slots })` in `createAgent`'s `middleware` |

More frameworks get an example once their adapter is released:

| Folder | Framework | Waits for the release of |
| -- | -- | -- |
| `ai-sdk/` | Vercel AI SDK (`ai`) | `/frameworks/ai-sdk` (merged, not yet on npm) |
| `langchain-python/` | LangChain (`langchain`, Python) | the Python LangChain middleware |
| `langgraph-typescript/`, `langgraph-python/` | LangGraph, a hand-built graph | the LangGraph chat model |
| `openai-agents-typescript/`, `openai-agents-python/` | OpenAI Agents SDK, across a handoff | the OpenAI Agents adapter |
| `pydantic-ai/` | Pydantic AI | the Pydantic AI capability |
| `mastra/` | Mastra | the Mastra processor |

## Before you start: the `airprompter` CLI

Every example serves its prompts with `airprompter dev`. The CLI is not on
npm or PyPI: it is a single executable on each `cli/v…` release on the
[releases page](https://github.com/airprompter/airprompter-agent-sdk/releases?q=cli%2Fv&expanded=true),
one per machine: `airprompter-darwin-arm64`, `airprompter-linux-x64`,
`airprompter-linux-arm64` and `airprompter-windows-x64.exe`. To fetch the
newest one on macOS or Linux (set `asset` for your machine):

```sh
asset=airprompter-darwin-arm64
tag=$(curl -fsSL "https://api.github.com/repos/airprompter/airprompter-agent-sdk/releases?per_page=100" | grep -o '"tag_name": *"cli/v[^"]*"' | head -n 1 | cut -d '"' -f 4)
curl -fsSL -o airprompter "https://github.com/airprompter/airprompter-agent-sdk/releases/download/${tag/\//%2F}/$asset"
chmod +x airprompter && mkdir -p ~/.local/bin && mv airprompter ~/.local/bin/   # any folder on your PATH
airprompter --version
```

On Windows, download `airprompter-windows-x64.exe` from the releases page
and put it on your `PATH` as `airprompter.exe`.

`airprompter dev` keeps the registry's dev keys in
`prompts/.airprompter-dev/`. `prompts/.gitignore` keeps them out of git;
keep that file when you copy the folder, because `keys.json` is a private
signing key.

## Pins

Each example pins every AirPrompter package exactly, as the
[changelog](../CHANGELOG.md) tells release-candidate users to. The pin is
this repository's version: `version-lockstep` fails while an example names
another, and `--set` moves it with the packages. Between a version bump and
its release, the pin names a version npm does not have yet, and `npm
install` in the folder fails. Copy from the newest `sdk-typescript/v…` tag
that has the example in that window. The examples start at `1.0.0-rc.5`: until it is on npm,
`node examples/ci/run.mjs` from a clone is the way to run one.

The examples ship no lockfile for the same reason: a lockfile cannot
resolve a version before it is on npm. The framework packages are pinned
exactly; what they depend on resolves fresh, as it does for a developer
copying the folder.

## How CI runs them

The [`examples` CI job](../.github/workflows/ci.yml) runs every example
unchanged with [`ci/run.mjs`](ci/run.mjs), on Node 22 and 24. It serves
`prompts/` with `airprompter dev` built from the same commit, installs the
SDK packed from that commit in place of the pin, and points the framework
at a fake provider ([`ci/fake-provider.mjs`](ci/fake-provider.mjs)) that
plays one recorded tool loop. No provider key is used. It checks that the
approved prompt and the release's model reached the provider on every call,
and that the spool holds one run with `count: 1` for the whole request.
Then it edits the prompt while the registry runs and runs the example
again: every call must carry the edited text. Every week
`wrap-latest.yml` runs them again against each framework's newest release
(`--latest`), and as a developer gets them, from npm with the newest
released CLI (`--published`).

## Adding an example

A new framework example is a folder here, added in its own pull request
once its adapter is released, with:

- **One agent file** of about 40 lines, on public imports only
  (`@airprompter/agent-sdk`, `@airprompter/agent-sdk/frameworks/<name>`,
  `airprompter_agent`, `airprompter_agent.frameworks.<name>`), with no test
  seam and a file header. It handles one request in one run, prints the
  final answer, calls `ap.stop()` and exits: a plain script, never a dev
  server.
- **The same registry settings:** `organizationId` `org_dev`, `agentId`
  `agt_dev`, `target` `dev`; the key from `AIRPROMPTER_AGENT_KEY`; the base
  URL from `AIRPROMPTER_BASE_URL`, defaulting to `http://127.0.0.1:4180`
  (CI serves the registry on a free port); the root from
  `../prompts/.airprompter-dev/root.pub.json`, relative to the agent file,
  with `hostedEnvironment: "dev"`; `sync: { rootUrl:
  "<base URL>/roots/dev/root.json" }`, without which the agent cannot learn
  the keys that sign a release and runs its own prompt; and `await
  ap.syncNow()` right after `start`, so a one-request script takes the
  newest approved version before its first call.
- **The provider through its defaults:** OpenAI, reached by the framework's
  own OpenAI client, which reads `OPENAI_BASE_URL` and `OPENAI_API_KEY`. If
  a framework does not read `OPENAI_BASE_URL`, pass it in one visible line
  and say why. The fake answers Chat Completions and the Responses API,
  both without streaming or `previous_response_id`; an example that needs
  either extends it first.
- **The model.** Where the adapter puts the release's model on the call
  (LangChain), the code names another model, so CI proves the swap. Where
  the adapter declines a call to another model (the AI SDK, direct
  clients), the code names the release's model, `gpt-5-mini`.
- **Exact pins** on every AirPrompter package and every framework package.
- **A README** with these parts, in this order, so the docs can link them:
  the one line that adds AirPrompter, as it appears in the agent file; the
  Node or Python version it needs; `## Run it`; `## How CI checks it`;
  `## Make it your agent`.
- **Wiring:** an entry in `EXAMPLES` in [`ci/run.mjs`](ci/run.mjs) (the job
  fails on an example folder that is missing from it), the folder in the
  examples entry in `.github/dependabot.yml`, and its row moved to the first
  table above. A Python example also extends
  `sdk-python/tools/version_lockstep.py` to read `examples/*/pyproject.toml`,
  and `ci/run.mjs` with a `python` runner.

`prompts/` holds only prompt files: `airprompter dev` serves every `.md`,
`.txt` and `.prompt` file in it as a slot.

## Other examples

- [`python-worker/`](python-worker/): a queue worker that calls Anthropic
  directly, with `instrument(client, ap, slot=…)` from
  `airprompter_agent.frameworks.anthropic`.
- [`spool-writer/`](spool-writer/): writing telemetry windows to the spool
  **without** the SDK, in TypeScript and Python, for teams that instrument
  the provider SDKs themselves. Both writers pass `protocol/vectors/spool.json`
  under `conformance/run.mjs`.
- [`conformance-adapter/`](conformance-adapter/): the Python SDK behind the
  conformance harness's JSON-lines adapter.
