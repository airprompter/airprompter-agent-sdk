# airprompter-agent-runtime

Serve a verified AirPrompter agent release you already hold: `ReleaseResolver`
decides which slot a subject gets under which arm — the signed ramp plan
walked on this host's clock, a retreat honoured, a disabled agent or slot
refused — and renders the text with its run reference; `wrap_client` and
`observe_call` attribute a model call to a render and classify what came
back; `ManagedAgent` is the hosted-execution client. No store, no daemon,
no network of its own.

```python
from airprompter_agent_core import BundleRelease, trusted_root_from_pinned_key
from airprompter_agent_runtime import ReleaseResolver

loaded = BundleRelease.load(bundle=bundle, root=trusted_root_from_pinned_key(purpose="platform", environment="prod", pinned_root=pinned), scope=scope, now=now)
runtime = ReleaseResolver(release=loaded.current(), run_ref_key=key, agent_id=agent_id, target="prod", instance_id=instance_id, now_ms=now_ms)
outcome = runtime.resolve("support.triage", user_id)
if outcome.ok:
    r = runtime.render(outcome.slot, {"ticket": ticket_text})
```

One of five distributions released in lockstep — `airprompter-agent-core`,
`-sync`, `-runtime`, `-telemetry` and the facade `airprompter-agent` — one
version, exact-pinned siblings, mirroring the TypeScript packages one for
one. The full README and the parity matrix are in
[`sdk-python/README.md`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/sdk-python);
the protocol is in [`protocol/`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/protocol).
BSD-3-Clause.
