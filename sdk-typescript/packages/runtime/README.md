# @airprompter/agent-runtime

Serve a verified AirPrompter agent release you already hold: `ReleaseResolver`
decides which slot a subject gets under which arm — the signed ramp plan
walked on this host's clock, a retreat honoured, a disabled agent or slot
refused — and renders the text with its run reference. The provider
wrappers (`wrapClient`, `aiSdkMiddleware`, `observeCall`) attribute a model
call to a render and classify what came back; `ManagedAgent` is the
hosted-execution client. No store, no daemon, no network of its own.

```ts
import { BundleRelease, trustedRootFromPinnedKey } from "@airprompter/agent-core";
import { ReleaseResolver } from "@airprompter/agent-runtime";

const loaded = BundleRelease.load({ bundle, root: trustedRootFromPinnedKey({ purpose: "platform", environment: "prod", pinnedRoot }), scope, now: new Date().toISOString() });
if (!loaded.ok) throw new Error(`bundle refused: ${loaded.reason}`);
const runtime = new ReleaseResolver({ release: loaded.release.current(), runRefKey, agentId, target: "prod", instanceId, nowMs: Date.now });
const slot = runtime.resolve("support.triage", userId);
if (slot.ok) {
  const r = runtime.render(slot, { ticket: userMessage }); // { text, model, versionId, arm, generation, runRef, tag }
}
```

The `openai`, `@anthropic-ai/sdk` and `ai` packages are optional peers:
nothing here imports them.

One of five packages released in lockstep — `@airprompter/agent-core`, `-sync`,
`-runtime`, `-telemetry` and the facade `@airprompter/agent-sdk` — one
version, exact-pinned siblings. The direction is core → clients → sdk and is
linted. The full README, the module map and the compatibility table are in
[`sdk-typescript/README.md`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/sdk-typescript);
the protocol is in [`protocol/`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/protocol).
BSD-3-Clause.
