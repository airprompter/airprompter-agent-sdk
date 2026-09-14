# @airprompter/agent-sync

Pull and hold AirPrompter agent releases: `syncOnce` (root → pointer →
manifest → only the changed payloads → verify → stage → policy), the
encrypted restart-safe two-slot store (`SlotStore`: stage → fsync →
activate, anti-rollback counter outside the slots, the data key wrapped by a
`KeyProvider`), the apply policy and its update windows, and `DaemonClient`
(the socket side of `protocol/daemon-socket.md`). Install it alone when your
CI pulls and verifies, or a host holds releases and decides when they apply.

```ts
import { SlotStore, fileKey, syncOnce } from "@airprompter/agent-sync";
```

What the store or the daemon loads is a `LoadedRelease`
(`@airprompter/agent-core`) for `@airprompter/agent-runtime` to serve. This
package never imports the runtime or the telemetry package.

One of five packages released in lockstep — `@airprompter/agent-core`, `-sync`,
`-runtime`, `-telemetry` and the facade `@airprompter/agent-sdk` — one
version, exact-pinned siblings. The direction is core → clients → sdk and is
linted. The full README, the module map and the compatibility table are in
[`sdk-typescript/README.md`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/sdk-typescript);
the protocol is in [`protocol/`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/protocol).
BSD-3-Clause.
