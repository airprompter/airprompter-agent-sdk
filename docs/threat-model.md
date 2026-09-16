# Threat model — stated so nobody sells more than this

This is the threat model of the AirPrompter Team Agents design (revision 8,
2026-09-14, §1), reproduced **verbatim** and then mapped to what this
repository actually does — and, since the package split (S10), to the
package each mechanism and its vector live in. The two "not defended" rows are part of the
contract: a security review that does not see them has been shown the
wrong document.

## The rows, as written

| Adversary | Can do | Stopped by |
|---|---|---|
| Stolen Agent API key | Pull the target's bundle (read-only) | Prompts are treated as confidential: TLS + at-rest encryption on the client; key revocation ends future pulls; lease expiry degrades stale runtimes; the key can only read *its* agent and target. |
| Compromised AirPrompter account with publisher rights | Compose and promote a release | Governance quorum + ledger (existing); `unlock_required` targets stage only — an unlock approves *what users see*, a rollout's whole ramp plan included; the cloud may push reductions only (`disable` an agent, a slot or an arm), never a reweight, an activation or a loosened policy; the host's apply policy pins on first use and a later update may tighten it, never loosen it; `requireCountersign` targets refuse anything the customer's release key did not sign. |
| Network attacker (MITM, malicious CDN) | Alter bytes in flight | Signatures on the manifest, SHA-256 on every payload, anti-rollback generation. TLS is defence in depth, not the trust root. |
| Attacker with disk access on the customer host (backups, snapshots, another tenant on the box) | Read the local store | AES-256-GCM per payload; DEK wrapped by a KEK the process obtains at boot from an OS keystore or the customer's KMS; AAD binds ciphertext to agent/target/hash. |
| Attacker with access to the customer's own release store (the fleet pattern: a database row, an object, a config entry) | Read prompt text; tamper a row; restore an old row | Rows are `.apbundle` ciphertext sealed to the fleet's distribution key (the private half lives only on runtimes); a tampered bundle fails the manifest signature or a payload hash and is refused BEFORE a byte is staged, so a fresh runtime is never left holding a forged generation; a relabelled bundle fails its AAD; an older row is refused below the held generation and a locally rolled-back generation stays held back. What a compromised store CAN do: withhold newer releases (the runtimes keep serving what they hold; `pull --check` and the fleet view's generation spread show it). |
| Attacker with process-level access on the customer host | Read plaintext prompts from memory | **Not defended.** Nothing on the vendor's side can protect bytes from the process that renders them. Say so in docs. |
| Hostile AirPrompter insider | Read prompts (we are the system of record); attempt to ship a malicious release | Reading is not preventable and must not be marketed as such. Shipping is bounded by countersign (§6.3): the customer key never leaves the customer. |

Three things the design says plainly beside the table, repeated here so
they travel with it:

- **Enforcement classes.** Issuance and distribution are *hard* (only
  approved versions can be sealed; every fetch needs a live Agent key;
  manifests are signed; payloads are content-addressed). Continuation is
  *lease-bounded* (the only lever that reaches a running process). Which
  version ran, on which model, how it did, is *advisory, observed*.
- **Two keys to activate.** Staging a release on the remote system is
  AirPrompter's decision; activating it may be the remote side's
  (`unlock_required`, countersign). A compromised AirPrompter account can
  stage bytes on a locked target but cannot make them live.
- **What signatures do not do.** They do not hide prompts from
  AirPrompter, and they do not stop a host-level attacker.
- **The customer client controls what is ever loaded** (revision 8, the
  owner's ruling behind S3, S4 and S9). Four rules make that true, each
  with a vector: the runtime trusts only the root it pins; the apply
  policy is pinned on the host on first use and a later update may
  tighten it, never loosen it; the set of directives honoured without a
  local act is closed to reductions (`disable`), and an unknown kind
  refuses the whole manifest; and an edge pointer can point at a
  generation but never extend a lease or hide a Freeze. AirPrompter's
  side is convenience — the pointer, the request, the plan — never
  authority.

## Claim → row → what the code does → what proves it

Every security claim in these docs and the READMEs maps to one row above.
A claim that maps to nothing is not a claim we make.

| Claim (as the docs say it) | Row | Mechanism in this repository | Package | Proof |
|---|---|---|---|---|
| A key can only read its own agent and target | Stolen key | The heartbeat, manifest and payload routes take the Agent key; the manifest's `organizationId`/`agentId`/`target` must equal the runtime's scope (M6) | core | `protocol/vectors/manifest-verify.json` "manifest for another organization / agent / staging manifest presented to a prod runtime"; `trust-chain.md` M6 |
| Prompts are encrypted at rest on the client | Stolen key · Disk access | `SlotStore`: AES-256-GCM per payload under a DEK; AAD `agentId target generation contentHash`; the DEK wrapped by a `KeyProvider` (file key, or the customer's KMS) | sync | `sdk-typescript/test/store.test.ts`, `sdk-python/tests/test_store.py`; [key-handling.md](key-handling.md) |
| Revocation ends future pulls; a lapsed grant is refused | Stolen key | Every fetch carries the key; the telemetry grant expires ≤ 15 min and the uploader refuses to post on a lapsed one before any bytes move | core · telemetry | `sdk-typescript/test/uploader.test.ts` "a lapsed grant is refused" |
| Lease expiry degrades stale runtimes | Stolen key | `leaseSeconds` in the signed manifest; a runtime that cannot check in marks itself `lease_expired` and degrades or halts per target | sdk (the loop) · core (the manifest field) | `sdk-typescript/test/agent.test.ts` "the lease counts from the last successful contact" |
| A stale or pinned edge pointer cannot extend trust or hide a Freeze | Network position between the fleet and the edge | The lease renews only on a signed manifest or an authenticated origin answer, never on the pointer; the heartbeat's `latestGeneration` sends a runtime whose pointer lags straight to the signed manifest; attached SDKs take the daemon's lease | core (the client) · sync (the loop) · sdk | `sdk-typescript/test/pointer.test.ts` "a pinned pointer does not renew the lease", "latestGeneration bypasses a lagging pointer", "an attached SDK takes the daemon's lease"; [`../protocol/trust-chain.md`](../protocol/trust-chain.md) › The pointer never extends trust |
| The apply policy is the customer's: a manifest may tighten a host's policy and never loosen it | Compromised publisher · Hostile insider | The first verified manifest pins `applyPolicy` in `store.json`; a later `unlock_required` tightens the pin, a later `auto` is advisory (logged, reported on the heartbeat as `applyPolicy.source: pinned`); only an operator's `airprompter policy set` loosens it; the process's own `apply.policy` can only add strictness | sync (`store.json`) · sdk · cli | `sdk-typescript/test/policy.test.ts` "trust-on-first-use, tighten, never loosen", "a local apply.policy…"; `sdk-python/tests/test_policy.py`; `cli/test/cli.test.ts` "S4"; `cli/test/daemon.test.ts`; [`../protocol/trust-chain.md`](../protocol/trust-chain.md) › The apply policy is the customer's |
| The cloud can push reductions only: the honoured directive set is `disable`, and an unknown kind refuses the manifest whole | Compromised publisher · Hostile insider | M13 `directive_unknown` before any payload is fetched — a `disable` beside an unknown kind is not obeyed either; `request_unlock` never activates | core (M13) · runtime | `protocol/vectors/manifest-verify.json` "a directive of a kind the runtime does not honour…"; `sdk-typescript/test/policy.test.ts` "the pushable set is closed"; `sdk-python/tests/test_policy.py` |
| A rollout's ramp is what the customer unlocked, walked on the host's clock; the cloud can only retreat | Compromised publisher · Network position | The plan is inside the signed manifest (`experiment.ramp`, trust-chain M14); the walk needs no check-in; `disable scope: "arm"` is the one push and only ever hands share back to the control; a plan that moves share up is a new generation and waits on `unlock_required` | core (assignment) · runtime (the resolver) | `protocol/vectors/ramp.json`; `sdk-typescript/test/ramp.test.ts` "the runtime walks the plan…", `sdk-python/tests/test_ramp.py`; [`../protocol/assignment-hash.md`](../protocol/assignment-hash.md) › The ramp plan |
| A staged release cannot be made live from AirPrompter's side | Compromised publisher | `unlock_required` stages into the inactive slot; activation is a local operator, a local window, or the customer's hook; AirPrompter can only *request* | sync (apply policy, windows) · sdk · cli | `sdk-typescript/test/agent.test.ts` "unlock_required stages until unlocked"; [change-control.md](change-control.md) |
| A countersign target refuses anything the customer key did not sign | Compromised publisher · Hostile insider | `requireCountersign`: every release digest (each arm's too) must carry a countersignature under the customer root; the local side may require it even when the manifest does not | core | `manifest-verify.json` countersign cases (missing / valid / foreign / wrong digest / corrupted / locally required / both arms) |
| Bytes altered in flight are refused | Network attacker | ES256 over the canonical payload; SHA-256 and declared length on every payload; monotonic generation (server rollback is a new generation) | core | `manifest-verify.json` "payload altered after signing", "signature bytes corrupted", "payload bytes that do not hash", "generation below the stored one" |
| A compromised signing key cannot authorize its successor | Network attacker · Compromised publisher | The SDK pins an offline **root**; root metadata lists the signing keys with expiry; rotation is signed by root; a key absent from current root metadata is unverified | core | `manifest-verify.json` root cases (stranger, targets-key-as-root, altered, expired, rotation) |
| An offline update file cannot be relabelled to another agent or target | Network attacker | `.apbundle` HPKE with AAD `agentId|target`; decryption under another label fails | core (`.apbundle`) · cli | `sdk-typescript/test/hpke.test.ts`; `cli/test/cli.test.ts` "another target" |
| Telemetry carries no prompt text, output, or end-user identifier | Hostile insider (what we can read) | The window schema has no field for content; the ingest drops unknown fields; feedback is numbers, booleans and declared enums only; golden runs and judgements report counts only | core (row schemas) · telemetry · otel-bridge | `protocol/vectors/spool.json`, `feedback.json`; `sdk-typescript/test/golden.test.ts` "never the output"; `spool-format.md` "What must never be in the spool" |
| Only the customer client decides what is ever loaded; AirPrompter's side is convenience, never authority | Compromised publisher · Network position · Hostile insider | The four rules above (pinned root; the policy pin; the closed reduction set; the pointer that never extends trust), plus the vendored bundle a host may be told to trust over any network source | core · sync · runtime · sdk | the four claims' vectors above; `sdk-typescript/test/vendored.test.ts`, `sdk-python/tests/test_vendored.py` |
| **We do not defend against process-level access on the host** | Process-level access | Nothing. The process that renders holds the plaintext; a debugger, a core dump, or a same-user process reads it | — | — (`SECURITY.md`, this page, the one-pager) |
| **We do not hide prompts from AirPrompter** | Hostile insider | Nothing. AirPrompter is the system of record for the prompt text | — | — (`SECURITY.md`, this page, the one-pager) |
| A host attacker who also holds the KEK reads the store | Disk access (boundary) | Nothing beyond the KEK's own custody — the KEK is the boundary | sync (key providers) | `SECURITY.md`; [key-handling.md](key-handling.md) |

## Where each claim lives (the package map, S10)

Six npm packages and five PyPI distributions, released in lockstep, with
one direction (core → clients → facade) that is linted. A claim's
mechanism and its vector live in the package that implements it; the
`Package` column above names it.

| Package (npm · PyPI) | Holds | Claims |
|---|---|---|
| `@airprompter/agent-core` · `airprompter-agent-core` | The protocol with no I/O: canonical JSON, the trust chain (root metadata, manifests, countersign, M1–M14), assignment and the ramp walk, the render, output checks, `.apbundle`, the telemetry row schemas, the control-plane client, the port interfaces, the CI kit (`/testing`) | key scope; signatures and hashes; root rotation; countersign; the closed directive set; the ramp maths; the relabel refusal; the row schemas |
| `@airprompter/agent-sync` · `airprompter-agent-sync` | The encrypted slot store and `store.json` (the policy pin lives here), the apply policy and its windows, the key providers, the sync loop, the daemon client | encryption at rest; the KEK boundary; the policy pin; staging under `unlock_required` |
| `@airprompter/agent-runtime` · `airprompter-agent-runtime` | Rendering and assigning over a release the host already holds (`BundleRelease`, `ReleaseResolver`), the provider wrappers, the hosted-execution client | the ramp walked on the host's clock; `disable` honoured at render |
| `@airprompter/agent-telemetry` · `airprompter-agent-telemetry` | The content-free spool, the uploader and its sinks | the lapsed grant refused; content-free telemetry |
| `@airprompter/otel-bridge` · (`airprompter_agent_telemetry.otel`) | The spool as OTLP metrics to the customer's collector, no grant | content-free telemetry (a closed attribute set) |
| `@airprompter/agent-sdk` · `airprompter-agent` | The facade: the loop, the lease, the heartbeat, the pointer, healthz | lease expiry; the pointer rule; the loop that stages and never activates on its own |
| the `airprompter` CLI and `airprompterd` | Operators: pull, verify, apply, unlock, policy, doctor, the daemon | the operator's acts (unlock, policy set) that the design reserves to the host |

## What the docs may not say

- That AirPrompter cannot read a customer's prompts.
- That a prompt on a customer host is protected from that host's
  administrators, debuggers or memory.
- That TLS is what makes distribution trustworthy (it is defence in depth).
- That telemetry "is anonymised": it is **content-free by schema**, which is
  a stronger and narrower statement.
