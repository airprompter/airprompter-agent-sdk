# Customer documentation

What a customer's security or platform team needs to evaluate and run
Team Agents, written against the design's stated threat model (revision
7, 2026-09-12) — never beyond it. The protocol documents under
`../protocol/` are the contract; the pages here are the narrative over
them. Both cite the design revision they follow.

## Page map

| Page | Answers | Design sections |
|---|---|---|
| [threat-model.md](threat-model.md) | What we defend against, what we do not, and which vector proves each claim | §1 |
| [key-handling.md](key-handling.md) | The six keys, who holds them, what a compromise means, how each rotates | §5, §6.1, §6.3, §10 |
| [change-control.md](change-control.md) | How your change control, update windows, CI, golden sets, countersign, freeze and rollback plug into activation | §6.2–6.5, §8.2 (5-D) |
| [telemetry.md](telemetry.md) | The spool contract in one table and the field → OpenTelemetry mapping | §9, §9.3 |
| [ingest.md](ingest.md) | Your prompts (a git directory, a database table, an export) become reviewable versions: `airprompter login` + `airprompter import`, the derived id, what a re-run does | S11 |
| [variables.md](variables.md) | Variables filled from your own system at render time: sources, precedence, trust (the stricter wins), `renderAsync` / `render_async`, `needs()`, workflows and managed mode | 0.2.10 (TS), 0.2.11 (Python) |
| [change-notification.md](change-notification.md) | How a fleet learns a release moved: the pointer-first pull (a CDN 304 per idle interval, the API only on a promotion) and the proposed nudge on a channel the customer owns (SQS / SNS / EventBridge / webhook) — pull-and-verify stays the only source of truth | 0.2.8 |
| [operator-tooling.md](operator-tooling.md) | `airprompter doctor` (every reason a host is not serving, with the remedy), the in-process `healthz`, `telemetry validate`, the verify GitHub Action, the published conformance harness and its adapter contract | S14 |
| [`../protocol/trust-chain.md`](../protocol/trust-chain.md) | Root metadata acceptance (R1–R5), manifest verification (M1–M12), refusal vocabulary, rotation | §5 |
| [`../protocol/canonical-json.md`](../protocol/canonical-json.md) | The encoding under every digest and signature; what the digest covers | §5 |
| [`../protocol/spool-format.md`](../protocol/spool-format.md) | The spool: files, rows, what may never be in it, upload, offline, third-party writers | §9.1, §9.3 |
| [`../protocol/checks.md`](../protocol/checks.md) | Declared output checks: the kinds, the JSON Schema subset, the regex safety rule | §8.2 (5-E) |
| [`../protocol/golden-sets.md`](../protocol/golden-sets.md) | Golden sets before activation; the customer-side judge | §8.2 (5-D), §9.2 |
| [`../protocol/compatible-endpoints.md`](../protocol/compatible-endpoints.md) | Managed mode through OpenAI- and Anthropic-shaped endpoints | §11.2, §18 |
| [`../protocol/daemon-socket.md`](../protocol/daemon-socket.md) | One sync loop per host, the socket, the uploader | §9.1 |
| [`../protocol/store-format.md`](../protocol/store-format.md) | `store.json` as a cross-package contract: N/N-1, migrate on first write, `store_newer` naming the writer (S8) | D35 |
| [`../protocol/assignment-hash.md`](../protocol/assignment-hash.md) | Sticky rollout assignment | §8 |
| [`../SECURITY.md`](../SECURITY.md) | Reporting, and the threat model in one paragraph | §1 |
| [`../sdk-typescript/README.md`](../sdk-typescript/README.md), [`../sdk-python/README.md`](../sdk-python/README.md), [`../cli/README.md`](../cli/README.md) | Using the SDKs and the CLI | §11 |

The printable one-page security overview for sales conversations lives
in the AirPrompter repository (`docs/client/team-agents-security.html`)
and is regenerated from the same design; its threat table is the table in
[threat-model.md](threat-model.md), row for row.

## The conformance suite as narrative

Every vector file under `../protocol/vectors/` is the executable form of a
paragraph in these pages. A claim without a vector is documentation; a
vector without a paragraph is a rule nobody can read.

| Vector | The paragraph it proves |
|---|---|
| `manifest-verify.json` — root metadata (10 cases) | [threat-model.md](threat-model.md) "A compromised signing key cannot authorize its successor"; `trust-chain.md` › Root metadata |
| `manifest-verify.json` — manifests (33 cases) | [threat-model.md](threat-model.md) "Bytes altered in flight are refused", "A key can only read its own agent and target", "A countersign target refuses…"; `golden-sets.md` › Conformance |
| `canonical-json.json` | `canonical-json.md` › Rules, The digest input |
| `assignment.json` | `assignment-hash.md` › Function |
| `workflow-steps.json` | the `workflow()` iterator's order and refusals (`sdk-typescript/README.md`) |
| `spool.json` | [telemetry.md](telemetry.md) › Segments, Latency; `spool-format.md` › Segment files, Row types |
| `feedback.json` | [telemetry.md](telemetry.md) › Feedback; `spool-format.md`; `golden-sets.md` › What leaves the host |
| `checks.json` | `checks.md` › Kinds, The regex safety rule |
| `examples/` and `examples/refused/` | one valid document per schema, and what each schema must reject — `spool-format.md` › What must never be in the spool is the `heartbeat.request.with-prompt-text` refusal |

`conformance/run.mjs` runs all of them against the reference
implementations; `node docs/check-links.mjs` verifies every relative link
and anchor in these pages resolves. Both run in CI.

## What these pages will not say

- Anything the [threat model](threat-model.md) does not defend.
- A revision the design has not reached. When §1, §5, §6, §9 or §10 of the
  design change, this folder and the one-pager are regenerated together
  and the revision stamp above moves.
