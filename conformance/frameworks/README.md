# Framework conformance

One recorded suite for every framework adapter, in both languages (AIR-2233).
Two harness sections, run by `../harness.mjs` through the same adapter
contract as the protocol vectors ([`../ADAPTER.md`](../ADAPTER.md)):

| Section | Operations | What it runs |
|---|---|---|
| `run-session` | `sessionScenario`, `unavailableReasons` | [`vectors/run-session.json`](vectors/run-session.json): rules 1 to 11 of the run session as scripts, on each SDK's real agent, no framework; and the SDK's reason list against [`vectors/placement-reasons.json`](vectors/placement-reasons.json) |
| `frameworks` | `driveRun` | every fixture in [`fixtures/`](fixtures) for the adapter's language, through the framework's real hooks, plus the coverage rule |

```sh
node harness.mjs --adapter adapters/agent-sdk.mjs --only frameworks,run-session
node harness.mjs --adapter-command "python ../examples/conformance-adapter/python/adapter.py" --only frameworks,run-session
```

**Equal rows.** Every deterministic session vector's rows must equal
[`vectors/run-session.rows.json`](vectors/run-session.rows.json), for both
SDKs: the spool's own lines (each adapter answers `wire`, the rows as the
uploader would send them), compared with every number by its digits, so `1`
and `1.0`, or two integers past 2^53 one double apart, differ. Only the
process's own `instanceId`, `sdk` and `instanceClass` are left out. After a
change to the vectors, rewrite the record from the TypeScript adapter with
`--write-golden` and review its diff; the Python SDK is then held to it.
`--compare <report.json>` also holds a run to another adapter's `--json`
report. A vector whose rows hang on a fresh run id or instance id says
`"deterministic": false` and is judged on its expectations alone.

The framework sections live in this repository only: they need the SDK under
test's drivers. The published `@airprompter/protocol-conformance` carries the
protocol sections.

## How a case runs

The harness seals each release into a plaintext bundle
([`release.mjs`](release.mjs), fresh keys per run) and hands the adapter the
bundle and the root key to pin. The adapter starts an **offline** agent (no
API key) over a memory sink and a fake clock, applies the bundle with
`applyBundle`, runs the case, stops the agent and answers what it wrote. Both
languages so open the same bytes: the same artifact ids, digests and salts.
The harness parses every run reference itself (`../reference.mjs`, with the
vectors' `runRefSecret`), so a reference is judged on what was minted.

`runRef` facts may differ in bytes between languages; the decoded facts must
match, and one vector parses a reference the TypeScript SDK minted.

## Run-session vectors

A vector is a release (a name in `releases`, inline, or `null` for none), a
script of steps on the fake clock, and what must come out. Runs are named
(`"run": "r"`); a step reads the run it names.

| Step | Does | Answers / `expect` |
|---|---|---|
| `open` | `ap.openRun(input)`; with `"scope": "run"`, inside `ap.run` until its `end` step (the sweep must skip it). `input.subject: { "runIdOf": "r" }` is that run's id; `input.resume: { "ref": "r" }` its current reference, `{ "forged": "r" }` that reference with its MAC altered | the run's reference, which must verify |
| `place` | `run.place(slot)`; `"concurrent": n` calls it n times at once | placement fields as a subset; `sameAs: i` equals step i's |
| `decline` | `run.decline(slot, "model_unresolved")` | as `place` |
| `setTags`, `slotFor` | the run's own | `slotFor`: `{ "slot": … \| null }` |
| `recordModelCall`, `recordToolCall` | with `call` in the TypeScript shape (`latencyMs`, `usage: { input, cachedInput, output, source }`, `errorClass`, `step`, `toolsObserved`) | |
| `end` | `run.end({ errorClass?, interrupted? })`; a scoped run's `ap.run` then returns | |
| `advance` | moves the fake clock `ms` | |
| `sweep` | the idle sweep, as every `openRun` runs it first (the spool timer and an invocation's edges call the same sweep); a vector proves a sweep ended a run with a late record after it (`run_late_record`), because `stop()` would end it anyway | |
| `swapRelease` | `applyBundle` of the next generation of another release | |
| `applyDirective` | `applyBundle` of the current release plus `directives` | |
| `feedback` | `ap.feedback(ref, signals, { slot?, model? })` on a run's reference or a literal `token` | `{ "filed": bool }` |
| `explain` | `ap.explain(ref)` on a run, a `token` or a `forged` run's reference | `entries`, each a subset, or `null` |
| `ref` | the run's current reference, decoded by the harness | `entries`, `entryCount`, `runIdOf`, `runIdNotOf`, `excludes` (strings the decoded body must not hold) |
| `restart` | stops the agent and starts a second one over the same store | |
| `sample` | `runs` runs, each opened with `input` (`{i}` is the run's index), placed on `slot` and ended | `distinct`: how many different placements |

`expect` at the vector's end: `rows` and `steps` (every window and step row,
each taken by one expected row matched as a deep subset), `rowCount`,
`agentRuns`, `runCounters` (exactly), `events` (log events by name: a count, or `{ count, fields }` when what each one carries matters),
`logExcludes`, `sourceCalls` (calls of the vector's `variableSources`).

A vector proves one rule (`rule`, 1 to 11). The rules and the cases each
needs are the AIR-2233 table; `../test/frameworks.test.mjs` checks every rule
has a vector. `awaiting_unlock` has no vector: these agents are offline, and
a first bundle activates whatever its apply policy says, so only an
over-the-air first release reaches it; each SDK's own run-session tests hold
it.

## Fixtures

`fixtures/<framework>/<kind>-<case>-<language>.json` (or
`<kind>-<language>.json`), one recorded run of a real framework
([`fixture.schema.json`](fixture.schema.json)): `tool-loop-ts.json`,
`handoff-two-slots-py.json`. The runner refuses a name that does not say the
fixture's kind and language. `recorded.turns`
are the provider responses, served in order through the framework's own
transport; `expect.calls` is what the provider saw, call by call, which is
the check that matters most. Rows and placements match on the fields named.
Placements come from the run's `run_placed` logs (a decline folded in) and
never carry text: the approved text and model are checked in `calls`.

**Coverage.** `run.mjs`'s `REQUIRED_KINDS` and `FRAMEWORK_TRAITS` say which
kinds each framework owes. Every framework adapter the SDKs ship (a module in
either SDK's `frameworks/` but the contract) owes them, with or without a
fixture folder, and so does every folder; the `frameworks` section fails,
naming the framework and the kind, for each one missing in the adapter's
language. A kind a framework is excused from is in `EXEMPTIONS` in `run.mjs`,
code reviewed like code, with the ticket that lifts it; an exemption that
names no ticket, or whose kind has a fixture, fails, and
`../test/frameworks.test.mjs` pins the set. A framework `FRAMEWORK_TRAITS`
does not list fails until it is added there.

**Drivers.** `drivers/<framework>.mjs` (TypeScript) and
`../../examples/conformance-adapter/python/drivers/<framework>.py` build the
framework as a developer would, with the adapter in place, run it against
`recorded.turns`, and return what the provider saw and the run references
they were handed. A TypeScript driver exports `driveRun({ ap, fixture,
clock, load })`; a Python one `def drive_run(*, ap, fixture, clock, **_)`,
sync or async (both contexts grow, so take what you use). Each returns `{
calls, runRefs, results?, state? }`; `results` (what the driver's own calls
answered) is matched against `expect.results`. `host.startAgent({ release,
runRefSecret, runRefPreviousSecrets })` (Python `host.start_agent(...)`)
starts another agent on its own store and the same clock, for the kinds about
another pod (`two-store`, `split-invocation`); its rows are collected too.
The direct-client drivers share one program shape (`drivers/program.mjs`,
`drivers/program.py`), described in `fixtures/openai/README.md`. A driver imports only what a developer's code
imports: the SDK's root, the framework's subpath, the framework (TypeScript
through `load`, which resolves from `sdk-typescript/node_modules` and refuses
anything else of the SDK at run time). If a driver needs an SDK internal, the
adapter is missing something; `../test/frameworks.test.mjs` also scans every
driver (Python by its syntax tree) and fails on one.

## Adding a framework

What AIR-2234 to AIR-2237 do, and nothing else: a driver, fixtures, and the
lines in `run.mjs` that name the framework.

1. **Name it.** Add the framework to `FRAMEWORK_TRAITS` (does it stream, take a
   node map, keep state?) and its package to `FRAMEWORK_PACKAGES`, per
   language. `REQUIRED_KINDS` then says what it owes; the coverage rule fails
   until each kind has a fixture or an `EXEMPTIONS` entry with its ticket.
2. **Write the driver.** `drivers/<framework>.mjs` exports `driveRun({ ap,
   fixture, clock, load, host })`; `examples/conformance-adapter/python/drivers/<framework>.py`
   defines `drive_run(*, ap, fixture, clock, host, **_)`, sync or async.
   Build the framework as its docs and the adapter's docs say, with the
   adapter in place, over the provider transport in `recorded.mjs` /
   `recorded.py` (or a fake model of the framework's real base class), so
   nothing reaches a provider. Pass `clock` as the adapter's `now`, so a
   latency replays the same. Return what the provider saw (`calls`), every run
   reference the framework handed back (`runRefs`), and `results` /
   `state` when the kind needs them. Import only what a developer's code
   imports; `test/frameworks.test.mjs` scans for anything else.
3. **Record the fixtures.** For each kind: the release (the same shape as the
   run-session vectors'), the agent's options in your driver's terms, the run
   input, the provider's turns in order, and what must come out. Run the
   framework once against the real client and recorded transport, read what
   the provider saw and what was written, check each field against what the
   kind proves (the ticket's table), and write the expectations down by hand.
   Name the version you recorded from in `frameworkVersion` (the installed
   one; `packages` for the others the run depended on): the `frameworks`
   section fails a fixture whose installed version differs. Exact-match only
   what the kind is about: a call's `settings` named in a fixture must be the
   call's settings exactly, so leave them out where a framework sends
   defaults of its own that the kind does not judge.
4. **Run it.** `node harness.mjs --adapter adapters/agent-sdk.mjs --only
   frameworks --framework <name>`, and the Python adapter the same way. Prove
   a case can fail: break the adapter's text or model insertion by hand and
   watch the case fail by name, then put it back.
5. **Pin it.** Python pins come from the fixtures (`pins.mjs py`), so CI
   installs what you recorded from. TypeScript pins are `sdk-typescript`'s
   exact devDependencies at the same versions. A version bump re-records:
   rerun, check, change `frameworkVersion` across the folder.

## CI

- **`frameworks` lane** (`.github/workflows/ci.yml`, every PR): both
  sections for both SDKs, the Python frameworks at their pins, Python's
  session rows compared with TypeScript's report, and the telemetry upload
  under a host's userland undici as the global dispatcher.
- **Weekly** (`.github/workflows/wrap-latest.yml`): `pins.mjs --matrix` reads
  each framework's newest release from npm or PyPI, and one job per
  framework and language installs exactly that version and runs its
  fixtures with `AIRPROMPTER_FRAMEWORKS_LATEST=1`. The job is named
  `<framework>@<version> (<language>)`, and each case names the version it
  ran.

## Adding an operation

Each file in [`operations/`](operations) is one section: `export default {
section, operations, slow?, run }`. A new file is a new section in every
adapter run; no existing code changes. A new operation brings its own cases
(`vectors/<operation>.json` or its own folder), never into `fixtures/`, which
holds `driveRun` fixtures only.
