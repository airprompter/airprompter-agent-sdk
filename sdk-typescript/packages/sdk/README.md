# @airprompter/agent-sdk

One install, today's `AirPrompterAgent`: the facade over
`@airprompter/agent-core`, `-sync`, `-runtime` and `-telemetry` — signed
pull-only updates, the encrypted restart-safe slot store, offline
operation, rendering with trust-aware variables, `ap.wrap()` for the
OpenAI, Anthropic and Vercel AI SDK clients, and content-free telemetry.
Every public name of the four packages is re-exported here, and the CI kit
is `@airprompter/agent-sdk/testing`.

```ts
import { AirPrompterAgent } from "@airprompter/agent-sdk";

const ap = await AirPrompterAgent.start({ organizationId, agentId, target: "prod", apiKey, root: { pinned }, sync: { mode: "resident", pollSeconds: 30, edgePointerUrl } });
const r = ap.prompt("support.triage").render({ ticket: userMessage });
const reply = await ap.observe(r, () => openai.chat.completions.create({ model: r.model, messages: [{ role: "user", content: r.text }] }));
ap.feedback(r.runRef, { thumbs: "up" });
```

A customer who wants less installs the sibling directly: the runtime alone
renders and assigns over a bundle, the sync package alone pulls and
verifies in CI, the telemetry package alone writes the spool.

One of five packages released in lockstep — `@airprompter/agent-core`, `-sync`,
`-runtime`, `-telemetry` and the facade `@airprompter/agent-sdk` — one
version, exact-pinned siblings. The direction is core → clients → sdk and is
linted. The full README, the module map and the compatibility table are in
[`sdk-typescript/README.md`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/sdk-typescript);
the protocol is in [`protocol/`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/protocol).
BSD-3-Clause.
