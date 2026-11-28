# @airprompter/agent-sdk

One install for `AirPrompterAgent`: signed pull-only updates, the encrypted
restart-safe slot store, offline operation, rendering with trust-aware
variables, framework adapters for the OpenAI and Anthropic clients, the Vercel
AI SDK and LangChain, and content-free telemetry.

```ts
import { AirPrompterAgent } from "@airprompter/agent-sdk";

// AirPrompter's production root key: the signing keys under it are read from https://api.airprompter.com/roots/prod/root.json.
const pinned = { kty: "EC", crv: "P-256", x: "hYhEFO-xyNoWyt5x0BgshEmNXPN1_mzDLISlT4nTDzE", y: "OTbj5sdj8qKiIPzCsrdD297_vlNqahPTZWGgoa9cOtE" };
const ap = await AirPrompterAgent.start({ organizationId, agentId, target: "prod", apiKey, root: { pinned }, sync: { mode: "resident", pollSeconds: 30 } });
const r = ap.prompt("support.triage").render({ ticket: userMessage });
const reply = await ap.observe(r, () => openai.chat.completions.create({ model: r.model, messages: [{ role: "user", content: r.text }] }));
ap.feedback(r.runRef, { thumbs: "up" });
```

The root is the agent and its option and result types.
Everything else is a subpath, and a subpath you do not import is not loaded:

| Subpath | What it holds |
| --- | --- |
| `/core` | The protocol with no I/O: trust chain, assignment, render, bundles, row schemas, the control-plane client |
| `/sync` | Pull and verify, the encrypted slot store, the apply policy, the customer's datastore |
| `/runtime` | Render and assign over a release you hold, the run session |
| `/telemetry` | The spool and its uploader |
| `/testing` | The CI kit: `FakeControlPlane`, `MemoryFs`, `FakeClock` |
| `/frameworks/openai`, `/frameworks/anthropic` | `instrument(client, ap, { slot })`: the approved text, model and settings on every call; the provider package is an optional peer |
| `/frameworks/ai-sdk` | `airprompterMiddleware(ap, { slot })` for `wrapLanguageModel`; `ai` is an optional peer |
| `/frameworks/langchain` | LangChain middleware; `langchain`, `@langchain/core` and `zod` are optional peers |
| `/frameworks/contract` | The contract every adapter follows, for writing your own; outside the 1.0 promise |
| `/frameworks/steps` | No-code automation steps (the core of the Zapier and n8n integrations); outside the 1.0 promise for now |

Separate packages exist only for dependency footprint and take this one as a
peer at the same version: `@airprompter/agent-otel`, `@airprompter/datastore-s3`,
`-postgres` and `-redis`. The full README and the module map are in
[`sdk-typescript/README.md`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/sdk-typescript);
the protocol is in [`protocol/`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/protocol).
BSD-3-Clause.
