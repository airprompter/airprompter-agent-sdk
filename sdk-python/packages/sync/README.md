# airprompter-agent-sync

Pull and hold AirPrompter agent releases: `sync_once` (root → pointer →
manifest → only the changed payloads → verify → stage → policy), the
encrypted restart-safe two-slot store (`SlotStore`), the key providers
(`file_key`, `custom_key_provider`, and the `[kms]`, `[vault]`, `[keyring]`
extras), the apply policy and its update windows, and `DaemonClient`.
Never imports the runtime or the telemetry distribution.

```python
from airprompter_agent_sync import SlotStore, file_key, sync_once
```

One of five distributions released in lockstep — `airprompter-agent-core`,
`-sync`, `-runtime`, `-telemetry` and the facade `airprompter-agent` — one
version, exact-pinned siblings, mirroring the TypeScript packages one for
one. The full README and the parity matrix are in
[`sdk-python/README.md`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/sdk-python);
the protocol is in [`protocol/`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/protocol).
BSD-3-Clause.
