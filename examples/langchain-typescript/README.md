# LangChain (TypeScript)

A support agent built with LangChain's `createAgent`, with one tool,
`lookup_order`. AirPrompter's middleware runs it on the approved prompt
`support.reply`. The whole agent is [`agent.ts`](agent.ts), and this is the
one line that adds AirPrompter:

```ts
middleware: [airprompter(ap, { slots: "support.reply" })], // the one line that adds AirPrompter; keep it last
```

With it, every model call in the request carries the release's system text
and model in place of your own, and the whole request counts as one run
against one version, however many model and tool calls it makes.

You need **Node 20 or later** and an OpenAI API key. You do not need an
AirPrompter account: the prompt comes from a local registry.

## Run it

1. **Get the code and the CLI.** The agent reads its prompt from
   [`../prompts/`](../prompts/), so clone the repository (or copy this
   folder and `prompts/` beside it):

   ```sh
   git clone --depth 1 https://github.com/airprompter/airprompter-agent-sdk
   cd airprompter-agent-sdk/examples/langchain-typescript
   ```

   Then install the `airprompter` CLI, which is not on npm:
   [Before you start](../README.md#before-you-start-the-airprompter-cli).

2. **Serve the prompts.** From this folder, in its own terminal:

   ```sh
   airprompter dev ../prompts
   ```

   This serves `../prompts/` as a signed registry on
   `http://127.0.0.1:4180`. Each file is a slot, so `support/reply.md` is
   `support.reply`. The first run makes a dev root key in
   `../prompts/.airprompter-dev/`, which the agent pins. Leave it running.

3. **Run the agent.** In a second terminal, from this folder:

   ```sh
   npm install
   OPENAI_API_KEY=sk-… AIRPROMPTER_AGENT_KEY=apa_dev_local npm start
   ```

   `apa_dev_local` is the local registry's fixed key. The agent looks up
   order A-1001 and prints its reply.

4. **Change the prompt.** Edit `../prompts/support/reply.md` and save. The
   registry signs a new version, and the next `npm start` runs on it. Your
   code does not change.

`package.json` pins `@airprompter/agent-sdk` and the LangChain packages to
exact versions. The SDK is a release candidate, so keep the exact pin when
you copy it ([Pins](../README.md#pins)).

## How CI checks it

The `examples` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
runs this folder unchanged with [`../ci/run.mjs`](../ci/run.mjs). It serves
`../prompts/` with the CLI built from the same commit, and points the agent
at [`../ci/fake-provider.mjs`](../ci/fake-provider.mjs), which plays a
recorded tool loop through `OPENAI_BASE_URL`. No provider key is used. The
job checks that every model call carried the approved prompt and the
release's model, `gpt-5-mini`, though `agent.ts` names `gpt-5-nano`, and
that the spool holds one run with `count: 1`. Every week `wrap-latest.yml`
runs it again against the newest LangChain releases, and as published.

To run the same check yourself, from the repository root:

```sh
(cd sdk-typescript && npm ci) && (cd cli && npm ci)
node examples/ci/run.mjs langchain-typescript
```

## Make it your agent

Four things change:

- **The key.** `AIRPROMPTER_AGENT_KEY` holds your agent's Agent key from the
  AirPrompter console, never `apa_dev_local`. Keep it out of your code.
- **The root.** These two lines replace `baseUrl`, `root` and `sync`, and
  the `registry` constant above the call goes:

  ```ts
  root: { pinned: { kty: "EC", crv: "P-256", x: "hYhEFO-xyNoWyt5x0BgshEmNXPN1_mzDLISlT4nTDzE", y: "OTbj5sdj8qKiIPzCsrdD297_vlNqahPTZWGgoa9cOtE" } },
  sync: { rootUrl: "https://api.airprompter.com/roots/prod/root.json" },
  ```

  The first pins AirPrompter's production root. The second is where that
  root lists the keys that sign each release: without it the agent cannot
  verify one, and your own prompt runs. The SDK verifies production
  releases from `1.0.0-rc.5` on.
- **The target.** `organizationId`, `agentId` and `target` name your agent
  and the environment it runs in, such as `prod`, as the console shows them.
- **The subject.** Pass your user's id as `subject` in place of
  `"customer-42"`, so each user stays on one version and an A/B split
  spreads across your users.

In a long-running server, start the agent once and drop `await
ap.syncNow()`: the agent polls for new versions on its own. Call
`ap.stop()` when the server shuts down.

Your OpenAI key stays yours. AirPrompter never sees it, or your messages.
