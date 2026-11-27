# What SDK 1.0 promises

From 1.0.0 the SDK follows [semantic versioning](https://semver.org/) over
the names on this page and nothing else. A name on a promised specifier is
removed or changed incompatibly only in a major release. A minor release may
add names and subpaths. A patch release changes neither.

The pinned lists are the promise, name by name. Each list is one name per
line in a test, so a change to the promise is a reviewed diff:

| Language | The pins |
|---|---|
| TypeScript | [`sdk-typescript/test/publicSurface.test.ts`](../sdk-typescript/test/publicSurface.test.ts) |
| Python | `PROMISE` in [`sdk-python/tests/test_package_shape.py`](../sdk-python/tests/test_package_shape.py): each module's `__all__` |

Before 1.0.0 the release candidates hold the same rule loosely: a candidate
may still remove a name, and says so in the [changelog](../CHANGELOG.md).

## What 1.0 promises

TypeScript, one package and four beside it, each on the same version:

| Specifier | What it is for |
|---|---|
| `@airprompter/agent-sdk` | The agent: `AirPrompterAgent`, its options, results and errors, and the run's types (`RunSession`, `Placement`, `AgentRuntime`, `RunInput`). |
| `@airprompter/agent-sdk/core` | The protocol with no I/O: verify a root and a manifest, canonical JSON, arm assignment and the ramp walk, render a template, output checks and golden sets, write and open a bundle and hold it as a release (`BundleRelease`), the telemetry row schemas, the control-plane client, the port interfaces. |
| `@airprompter/agent-sdk/sync` | Pulling and holding releases: the encrypted slot store and its key providers, the sync pass, the pointer-first pull, the apply windows, your datastore (`KvStore` and the release rows over it). |
| `@airprompter/agent-sdk/runtime` | Serving a release you already hold: `ReleaseResolver`, the slot's sealed settings (`applyInference`), the run's types, `observeCall`, the `ap.attribute` scope, variable sources. |
| `@airprompter/agent-sdk/telemetry` | The content-free spool (`SpoolWriter`, `DirectorySink`, `MemorySink`) and its uploader (`SpoolUploader`). |
| `@airprompter/agent-sdk/testing` | The CI kit: `FakeControlPlane`, `MemoryFs`, `FakeClock`, `serveOverHttp`. |
| `@airprompter/agent-sdk/frameworks/openai` | The OpenAI client adapter. |
| `@airprompter/agent-sdk/frameworks/anthropic` | The Anthropic client adapter. |
| `@airprompter/agent-sdk/frameworks/ai-sdk` | The AI SDK middleware. |
| `@airprompter/agent-sdk/frameworks/langchain` | The LangChain middleware. |
| `@airprompter/agent-otel/exporter` | The spool as OTLP metrics, to any collector. |
| `@airprompter/datastore-s3` | A `KvStore` over S3. |
| `@airprompter/datastore-postgres` | A `KvStore` over Postgres. |
| `@airprompter/datastore-redis` | A `KvStore` over Redis. |

Python, one distribution and four beside it, each on the same version. A
module's promise is its `__all__`; a layer's package carries other names as
attributes, for the layers above it, and they are not public. The names
differ where the languages do (`snake_case`, classes where TypeScript has
object literals and unions); each language's pins are its own. The
distributions ship `py.typed`, so type checkers read the annotations:

| Module | What it is for |
|---|---|
| `airprompter_agent` | The agent, its options and results, and the run's types: the Python counterpart of the TypeScript root. It loads on first use, so importing a layer never loads the agent. |
| `airprompter_agent.core` | As `@airprompter/agent-sdk/core`. |
| `airprompter_agent.sync` | As `@airprompter/agent-sdk/sync`, with the `kms`, `vault` and `os_keystore` key providers. |
| `airprompter_agent.runtime` | As `@airprompter/agent-sdk/runtime`. |
| `airprompter_agent.telemetry` | As `@airprompter/agent-sdk/telemetry`. |
| `airprompter_agent.testing` | The CI kit: `MemoryFs`, `FakeClock`. |
| `airprompter_agent.frameworks.openai` | The openai client adapter, sync and async. |
| `airprompter_agent.frameworks.anthropic` | The anthropic client adapter, sync and async. |
| `airprompter_agent.frameworks.litellm` | The LiteLLM callback. |
| `airprompter_agent_otel.exporter` | The spool as OTLP metrics, to any collector. |
| `airprompter_datastore_s3` | A `KvStore` over S3. |
| `airprompter_datastore_postgres` | A `KvStore` over Postgres. |
| `airprompter_datastore_redis` | A `KvStore` over Redis. |

What the promise covers, for every name on those lists:

- **The name and its kind.** A value stays a value, a class stays a class,
  a type stays a type, under the same specifier.
- **Its types.** A parameter does not narrow in a minor release, and an
  option may be added only as an optional one. Every type a promised
  signature reaches is one a promised specifier exports, so you can name it
  (the TypeScript pins check this); a member marked `@internal` is not in the
  declarations and not in the promise.
- **Open unions.** A string-literal union that names a kind, a reason or a
  code, or whose values come from the wire (`Placement["kind"]`,
  `UnavailableReason`, `RequestKind`, `InferenceUnsupportedReason`,
  `ErrorClass`, `RefusalCode`, `UsageSource`, `StoreErrorCode`, the keys of
  `SlotInference`), and the discriminant of a result union (`kind`, `status`:
  `BundleOutcome`, `FlushOutcome`, `HydrateOutcome`, …), may gain a member in
  a minor release. Give a `switch` (TypeScript) or an `if`/`match` chain
  (Python) a default branch that treats an unknown member as the safe case.
- **Interfaces the SDK hands you** (`RunSession`, `AgentRuntime`,
  `Placement`, a result or a status) may gain members in a minor release, so
  do not implement them yourself. **Interfaces you implement** (`KvStore`,
  `ReleaseDatastore`, `VariableSource`, `UploadSink`, `SpoolSink`, `FsPort`,
  `ClockPort`, `KeyProvider`, `FetchLike`, `ModelResolver`) never gain a
  required member before a major release.
- **Its documented behaviour**: what the READMEs and the pages under `docs/`
  say a listed name does.
- **Error identity.** An error is recognised by its `name` and `code`
  (`errorNamed`, `isStoreError`, …), never by `instanceof`, so two copies of
  the SDK in one process agree. In Python an error is a class per name,
  caught with `except`, and its `code` is the contract.
- **Both module systems** (TypeScript). Every specifier resolves from
  `import` and from `require`, each with its own declarations; dropping
  either is a major release.

A name leaves only in a major release, with a changelog line. A subpath may
ship outside the promise first (below) and move inside in a minor release;
it never moves back out before a major.

The wire is versioned apart from the SDK: the protocol in
[`protocol/VERSION`](../protocol/VERSION), the store in
[`store-format.md`](../protocol/store-format.md), the spool in
[`spool-format.md`](../protocol/spool-format.md), each with its own rules.

## Outside the promise

These resolve, and may change in any release:

- `@airprompter/agent-sdk/frameworks/contract` and
  `airprompter_agent.frameworks.contract`: the adapter contract (AIR-2231).
  It is what the adapters above are built on, and it keeps moving while new
  frameworks prove it. Write an adapter on it, and pin the SDK exactly.
- `@airprompter/agent-sdk/frameworks/steps`: the no-code automation core
  under the Zapier and n8n integrations, until they pass the shared adapter
  suite.
- Any name a promised specifier does not list. Each TypeScript layer has a
  barrel the other layers import (`core/index.ts` and its kin), and its names
  are not public: the subpath is the curated `public.ts` beside it. A Python
  layer's attributes outside its `__all__` are the same, and a module inside a
  layer (`airprompter_agent.core.protocol`, `airprompter_agent.core._util`)
  is never public.
- Any path past the exports map (`@airprompter/agent-sdk/dist/…`): Node
  refuses it with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- The text of a log line or an error message: an error's `code` is the
  contract, and the words may improve.
- The CLI's internals, and the source tree. The CLI's own commands and flags
  are described in [`cli/README.md`](../cli/README.md).
