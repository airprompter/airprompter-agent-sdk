# Trust chain

What a runtime checks before a release goes live, in the order it checks
it, and what it says when a check fails. `vectors/manifest-verify.json`
carries one case per refusal and the accept cases; every SDK must produce
the same verdicts.

## Keys and identifiers

* All keys are ECDSA P-256. Signatures are over SHA-256 of the signed bytes,
  encoded IEEE P1363 (`r ‖ s`, 64 bytes), base64url without padding
  (`alg: ES256`).
* `keyId` is the RFC 7638 JWK thumbprint of the public key: SHA-256 of the
  canonical JSON of `{ "crv", "kty", "x", "y" }`, hex, lowercase. A key-set
  that lists a key under any other id is refused (`key_id_mismatch`), so a
  key cannot be smuggled in under a trusted id.
* The **pinned root** is one public JWK per hosted environment, shipped in
  SDK source. Changing it is a visible commit in a public repository.
* Timestamps (`expires`, `notBefore`, `notAfter`, `issuedAt`, `now`) are
  RFC 3339 and compare as **instants**, never as strings: `…T00:00:00Z`
  and `…T00:00:00.000Z` are the same moment. The hosted service writes
  canonical millisecond UTC (`YYYY-MM-DDTHH:MM:SS.sssZ`).

## Signed bytes

| Document | Bytes signed |
|---|---|
| Root metadata (`key-set.schema.json`) | canonical JSON of `signed` |
| Manifest (`manifest.schema.json`) | canonical JSON of `payload` |
| Countersignature | UTF-8 of the `releaseDigest` string (`sha256:…`) |
| Offline bundle | nothing extra — it carries the manifest and root metadata above |

Canonical JSON is `canonical-json.md`. A signer and a verifier that disagree
on one byte disagree on everything, which is the point.

## Root metadata

A runtime holds one **trusted root document** per environment: at first
boot, a synthetic document containing only the pinned root key in the
`root` role with threshold 1; afterwards, the latest root document it
accepted. A candidate root document is accepted when, in this order:

| # | Check | Refusal |
|---|---|---|
| R1 | `purpose` and `environment` equal the trusted document's | `root_scope_mismatch` |
| R2 | every key in `keys` is listed under its own thumbprint | `key_id_mismatch` |
| R3 | `version` is greater than the trusted document's (equal only if the bytes are identical) | `root_rollback` |
| R4 | at least `threshold` signatures from keys in the **trusted** document's `root` role verify over the canonical `signed` bytes | `root_signature_invalid` |
| R5 | `expires` is after now | `root_expired` |

R4 is what makes rotation safe: a new signing key is authorized by the root
key, never by the signing key it replaces. R5 on an accepted document is
re-evaluated at every manifest check, so a root that expires while the
runtime holds it turns into `root_expired` on the next manifest.

**Expiry degrades, it never bricks.** `root_expired` and every other
refusal below apply to *new* manifests. The active release keeps serving;
the runtime reports the refusal on heartbeat and on evidence. An air-gapped
host past root expiry runs indefinitely on what it verified before.

## Manifest

Given a trusted, unexpired root document, a manifest is accepted when, in
this order:

| # | Check | Refusal |
|---|---|---|
| M1 | root document not expired at `now` | `root_expired` |
| M2 | `payload.protocol` major is one the runtime speaks | `protocol_unsupported` |
| M3 | at least one signature names a key in the root's `targets` role | `unknown_signing_key` |
| M4 | each such key is within its `notBefore`/`notAfter` at `now` (absent means unbounded) | `signing_key_expired` |
| M5 | signatures from those keys verify over the canonical `payload` bytes; at least one | `signature_invalid` |
| M6 | …and at least `targets.threshold` of them | `signature_threshold` |
| M7 | `organizationId`, `agentId`, `target` equal the runtime's configuration | `scope_mismatch` |
| M8 | `generation` ≥ the stored generation (equal is a no-op re-fetch, not a refusal) | `generation_rollback` |
| M9 | every payload the manifest references is present (slots, steps, arm overrides) | `payload_missing` |
| M10 | every present payload's SHA-256 equals its `contentHash` and its length its `byteLength` | `payload_hash_mismatch` |
| M11 | when `requireCountersign` (or the target is locally configured to require it): every release the manifest can activate — the manifest's `releaseDigest` and each experiment arm's — carries a countersignature from a key in the **customer** root's `targets` role | `countersign_missing` |
| M12 | …and each of those signatures verifies over the UTF-8 digest string | `countersign_invalid` |
| M13 | every `directives[]` entry is of a kind the runtime honours — `disable` or `request_unlock` (S4; checked with M7/M8, before any payload is fetched) | `directive_unknown` |
| M14 | `experiment.ramp`, when present, is a well-formed plan — 1–8 steps, strictly increasing and ≥ 1 h apart, one integer weight per arm summing to 10000 (S9, assignment-hash.md › The ramp plan) | `ramp_invalid` |

Only then does apply policy run — and the policy is the host's, not the
manifest's (see below): the manifest's `applyPolicy` pins the host on first
use or tightens it, never loosens it.

Notes:

* M3–M6 are evaluated over the set of signatures, so an envelope carrying
  one unknown key and one good key passes; one that carries only unknown
  keys is `unknown_signing_key`.
* Checks are ordered so that the cheapest structural refusals come first and
  no payload is fetched for a manifest that will be refused anyway. A
  runtime may run M9/M10 after fetching (they cannot be checked before) but
  reports them in this vocabulary.
* A local downgrade is never a manifest check: `airprompter rollback
  --force` writes `control_plane_refusal: forced_downgrade` on evidence.
* `model_unavailable` is the one refusal *after* the chain verified: a slot
  (or an arm override) with `modelRequired: true` names a model the runtime
  did not declare at start. The release stays unactivated, nothing is
  fetched, the active release keeps serving, and the heartbeat reports the
  refusal with `unavailableModels`. A runtime that declared no models is
  never refused over one — the check needs a catalog to check against.
* Countersign targets take `leaseSeconds`, `onLeaseExpiry` and every
  directive except `disable` from local configuration (D58); the manifest's
  values are advisory there.

## Rotation

1. The platform mints a new signing key.
2. A ceremony produces root document `version + 1`, listing both keys in
   `targets` (the old one with `notAfter`), signed by the root key.
3. Manifests are signed with the new key from then on; instances accept
   either until `notAfter`.
4. A later ceremony removes the old key. Manifests still signed by it are
   `unknown_signing_key` — `vectors/manifest-verify.json` has this case.

Evidence carries `signingKeyId`, so rotation progress is visible per fleet.
A compromised signing key ages out with the root document that lists it;
it can never sign its own successor into trust.

## Vectors

`vectors/manifest-verify.json` is generated by `tools/gen_trust_vectors.mjs`
from private keys embedded in the generator, so the file carries real
signatures over real canonical bytes. ECDSA signatures are randomised, so
the checked-in file is regenerated only deliberately; CI regenerates a
fresh file as well and runs the reference verifier over both, which proves
the chain logic and not one lucky nonce. Each case gives the runtime's
configuration (pinned root, stored root version, stored generation, `now`,
scope), the documents, and the expected verdict.

## The pointer never extends trust (S3)

The edge pointer (`generation.json`) is unsigned and cacheable: it tells a
runtime whether anything *may* have moved, cheaply, without a Lambda behind
it. It is therefore the thing a party between the fleet and the edge can
pin or serve stale, and a pinned pointer must not be able to keep a fleet
on the last release indefinitely — that would hide a Freeze (`disable`), a
retreat and a dial-down. Three rules:

1. **Pointer contact does not renew the lease.** The lease counts from the
   last *signed* manifest fetch (an envelope that verified, whether it
   activated, staged, was held back, or was unchanged at the same
   generation) or from an *authenticated* answer of the origin (the
   manifest route's `304`, the heartbeat's `200`). A `304` from the edge
   pointer, or a pointer whose generation is not above the active one,
   is silence, not contact.
2. **The heartbeat carries `latestGeneration`.** The authenticated answer
   names the environment's current generation as the origin knows it. A
   runtime whose pointer says less marks the pointer behind, fetches the
   signed manifest directly on its next pass (skipping the pointer), and
   only then trusts the pointer again.
3. **A runtime attached to a host daemon takes the daemon's lease.** The
   daemon is the process that talks to the origin; its `slot` answer and
   its `lease` event carry `leaseExpiresAt`, and an attached SDK never
   counts a local socket answer as contact with the registry.

Together: a stale or pinned pointer costs at most one heartbeat interval
of delay before the fleet sees what the origin has, and a runtime that can
reach only the pointer expires honestly.

## The ramp plan is what users will see (S9)

`unlock_required` approves what users see. A rollout's weights therefore
ride the signed manifest as a whole plan (`experiment.ramp`) that the
customer unlocks once; the fleet walks it on its own clock, and the cloud
can only retreat with `disable scope: "arm"` — a reduction in S4's sense,
honoured from any verified envelope without a local act. An adjustment
upward is a new plan and waits like any release. See assignment-hash.md ›
The ramp plan; vectors `vectors/ramp.json`, `sdk-typescript/test/ramp.test.ts`,
`sdk-python/tests/test_ramp.py`.

## The apply policy is the customer's (S4)

A manifest says `applyPolicy`, but a compromised or mis-edited control
plane could say `auto` where Production was `unlock_required`, and the
next verified release would go live with no local act. So the policy a
host runs under is the host's, recorded in `store.json`
(`applyPolicyPin`), and the manifest can only ever make it stricter:

1. **Trust on first use.** The first manifest that verifies on a host pins
   its `applyPolicy` (`source: "manifest"`, with the generation). Until
   then nothing is pinned and nothing is served.
2. **A manifest may tighten, never loosen.** A later manifest that says
   `unlock_required` against a pinned `auto` tightens the pin (logged
   `apply_policy_tightened`). One that says `auto` against a pinned
   `unlock_required` changes nothing: the release stages, the runtime
   logs `apply_policy_manifest_advisory` once per generation, and the
   heartbeat reports `applyPolicy: { effective, source }` so the fleet
   view can say the console's setting is advisory on that host.
3. **Loosening is an operator's act.** `airprompter policy set … auto`
   (host-wide through the daemon; `ap.setApplyPolicy("auto")` from a
   process) rewrites the pin with `source: "operator"`, logged with who
   asked. The next manifest that says `unlock_required` tightens it again
   — rule 2 always holds.
4. **The process's own `apply.policy` sits on top.** `unlock_required`
   there makes every release wait whatever the pin says; `auto` there is
   not a loosening.
5. **The set of directive kinds honoured without a local act is closed —
   the reduction set.** `disable` acts, in three scopes: the agent (every
   slot stops serving), a slot (`tag`), an arm (`scope: "arm"`, the arm's
   share goes back to the control). Each only ever stops or shrinks what
   users see; a Freeze lands on a pinned `unlock_required` host with no
   local act. There is no reweight, no activation and no loosening in the
   set. `request_unlock` asks and never grants. Any other kind refuses the
   whole manifest (M13, `directive_unknown`) — a runtime never obeys a
   manifest by halves.

Vectors: `sdk-typescript/test/policy.test.ts`, `sdk-python/tests/test_policy.py`,
`cli/test/cli.test.ts` "S4", `cli/test/daemon.test.ts`, and
`vectors/manifest-verify.json` "a directive of a kind the runtime does not
honour".

## Where each rule is implemented (S10, S15)

| Rule | Package |
|---|---|
| Signed bytes, root metadata, manifest rules M1–M14, rotation, countersign | `@airprompter/agent-core` · `airprompter_agent_core.protocol` (no I/O) |
| The pointer never extends trust | the client in core (`edgePointer`), the loop in `@airprompter/agent-sync` and the facade `@airprompter/agent-sdk` (the lease renews only on a signed manifest or an authenticated origin answer) |
| The ramp plan is what users will see | the maths in core (`rampWeightsAt`, `effectiveArms`), the walk in `@airprompter/agent-runtime` (`ReleaseResolver`) |
| The apply policy is the customer's | `store.json` and the pin in `@airprompter/agent-sync` (`SlotStore`); the operator's `policy set` in the CLI |
| The reduction set | M13 in core; `disable` honoured at render in runtime |

Every SDK's vectors run through the published harness
(`@airprompter/protocol-conformance`, S14) against these packages.
