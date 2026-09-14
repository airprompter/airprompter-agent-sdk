# @airprompter/agent-core

The pure half of the AirPrompter agent SDK: the wire types, canonical JSON
and SHA-256, the trust chain (root metadata R1–R5, manifest M1–M14), arm
assignment and the signed ramp plan walked on the host's clock, template
rendering with trust-aware fencing, declared output checks, golden sets,
the judge, `.apbundle` reading (HPKE), the telemetry row schemas, the
control-plane HTTP client, and the port interfaces (`FsPort`, `ClockPort`,
`FetchPort`) with their Node adapters. Nothing here opens a file, a socket
or a timer at import time, and nothing here depends on a sibling package.

```ts
import { verifyManifest, trustedRootFromPinnedKey, assignArm, renderTemplate, BundleRelease } from "@airprompter/agent-core";
import { FakeControlPlane, MemoryFs, FakeClock } from "@airprompter/agent-core/testing"; // the CI kit; never loaded by a runtime
```

`BundleRelease.load({ bundle, root, scope, now })` turns a bundle the
customer loads into a `LoadedRelease` — the seam `@airprompter/agent-runtime`
renders over — after the same chain as an over-the-air update: signatures,
scope, expiry, every payload hash.

One of five packages released in lockstep — `@airprompter/agent-core`, `-sync`,
`-runtime`, `-telemetry` and the facade `@airprompter/agent-sdk` — one
version, exact-pinned siblings. The direction is core → clients → sdk and is
linted. The full README, the module map and the compatibility table are in
[`sdk-typescript/README.md`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/sdk-typescript);
the protocol is in [`protocol/`](https://github.com/airprompter/airprompter-agent-sdk/tree/main/protocol).
BSD-3-Clause.
