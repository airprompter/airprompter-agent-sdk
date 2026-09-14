# airprompter-agent-core

The pure half of the AirPrompter agent SDK for Python: the trust chain (root
metadata R1–R5, manifest M1–M14), canonical JSON and SHA-256, arm assignment
and the signed ramp plan walked on the host's clock, template rendering
with trust-aware fencing, declared output checks, golden sets, the judge,
`.apbundle` reading (HPKE), the telemetry row schemas, the control-plane
HTTP client, and the port protocols with their OS adapters. Nothing here
opens a file, a socket or a thread at import time; nothing here imports a
sibling distribution. `airprompter_agent_core.testing` is the CI kit.

```python
from airprompter_agent_core import verify_manifest, trusted_root_from_pinned_key, assign_arm, render_template, BundleRelease
```

One of five distributions released in lockstep — `airprompter-agent-core`,
`-sync`, `-runtime`, `-telemetry` and the facade `airprompter-agent` — one
version, exact-pinned siblings, mirroring the TypeScript packages one for
one. The full README and the parity matrix are in
[`sdk-python/README.md`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/sdk-python);
the protocol is in [`protocol/`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/protocol).
BSD-3-Clause.
