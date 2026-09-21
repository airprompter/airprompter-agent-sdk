# Pins and seals (0.3.5)

A customer application may keep its own copy of a release — slot text,
settings, everything a pin covers — outside the daemon's store: a config
row, a database, a file checked into a deploy. `pins.md` is the contract
for that copy: how it identifies the release it was written from, how it
proves to itself that copy still matches, and how it asks to catch up when
it does not. Nothing here changes what a release *is* (canonical-json.md)
or how the trust chain verifies a manifest (trust-chain.md); a seal is a
read of a release the chain already verified, taken at rest.

## Seal

A release's identity is its `releaseDigest` (canonical-json.md): `"sha256:"
+ hex(SHA-256(UTF-8(canonical(pins))))`. A **seal** names that same digest
under a shorter id for places sixty-four hex characters is more than is
wanted — a URL, a config value, a support ticket:

* **`sealId`** is the first 12 hex characters after `sha256:` in the
  release digest, lowercase (`^[0-9a-f]{12}$`). It is derived, never
  chosen: two releases whose digests share a 12-character prefix share a
  `sealId`, and a lookup on the short form alone is ambiguous until more
  characters resolve it (`release_ambiguous`, below).
* The **`?release=` grammar** accepts either form: a full release digest
  (`sha256:` + 64 hex) or a short form — at least 12 hex characters of the
  digest's hex portion, an optional `sha256:` prefix, matched
  case-insensitively. Fewer than 12 characters is refused (`seal_invalid`):
  short enough to guess is not a seal.

## Pinned read

`GET …/manifest?release=<seal>` (`openapi.yaml`) answers with the latest
signed envelope sealed for that release **on this target** — not the
pointer's current envelope, and not necessarily the first envelope that
ever carried the release (a release can be promoted, rolled back to, and
promoted again; the pinned read tracks the newest envelope, same as an
unpinned read tracks the newest generation). The shape is identical to an
unpinned answer: the same manifest schema, `ETag` is still the sha256 of
the stored envelope, `If-None-Match` still answers `304`, and
`x-agent-generation` still carries a generation — the pinned envelope's,
not the pointer's, which is why a pinned reader must not compare it against
a generation it tracked from the pointer. `?release=` and `?wait=` are
never combined: a pinned read never long-polls, because the release it
names does not move by definition.

| HTTP | Code | Meaning |
|---|---|---|
| `400` | `seal_invalid` | `release` does not match the grammar above |
| `400` | `wait_with_release` | `wait` and `release` were both sent |
| `404` | `release_unknown` | this target has never sealed that release |
| `404` | `release_not_promoted_here` | the release was sealed, but for another target, or never promoted to this one |
| `409` | `release_ambiguous` | the short form matches more than one release sealed on this target; the body's `matches` lists each full short form — retry with more hex characters, or the full digest |

`release_unknown` and `release_not_promoted_here` are kept distinct in the
table above because an implementation may choose to collapse them (as
`404` already does for "no release" versus "key can't see it" on the
unpinned route) — nothing requires a caller be able to tell them apart,
only that both are `404`.

## Content pinned, control live

Pinning is a statement about **slots**, not about the whole relationship
with the control plane. A pinned runtime:

* renders the pinned envelope's slots — the text, the model, the inference
  settings, the variables — regardless of where the pointer has moved;
* keeps reading the **live** manifest for everything that is not a slot:
  `directives`, `leaseSeconds` / `onLeaseExpiry`, `requireCountersign`. A
  `disable` directive on a pinned slot is still honoured; a live
  `request_unlock` or `request_resync` is still surfaced. Pinning opts a
  slot out of the release, not out of governance.
* scopes the anti-rollback rule (trust-chain.md, `generation_rollback`) to
  the **pinned envelope's own generation** while pinned: a pinned reader
  compares a new pinned answer's generation against the last pinned
  generation it held, not against the live generation the pointer has
  moved past. Unpinning resumes following the pointer and re-bases the
  stored generation to the pointer's current one, so the first live
  manifest after an unpin is never seen as a rollback merely because the
  pointer outran the pin.

## Customer-store seal

What the customer's copy holds, so it can check itself later without a
network call: `sealId` (the release it was written from), every pin record
from that release verbatim (the same shape canonical-json.md projects into
the digest), and the slot and step texts themselves, keyed by
`contentHash`.

**Recomputing the seal**: a runtime holds two copies of the release's
pins — the ones it was sealed with (its verified store, or the pinned
envelope) and the customer's own copy, which time and hand-editing may
have moved out of step. For every pin (and, for a workflow pin, every
step) in the customer's copy, re-hash the held text with SHA-256 and
compare it to the pin's `contentHash`; a missing or mismatching text
substitutes the rehashed value into a working copy. Then canonical-JSON
that working copy's pins exactly as the release digest does
(canonical-json.md) and hash that — the result is `observedDigest`. The
store is **intact** when every text still hashes to its pin's
`contentHash` and `observedDigest` equals the seal's release digest;
otherwise it is **broken**.

`changedTags` names every pin member that changed — content-free, never
the text itself, before or after. It is the union of: a slot (by `tag`)
or step (by `stepId`, `<tag>#<ordinal>`) whose text is missing or
rehashes differently; a prompt slot present in both copies whose full
digest projection (canonical-json.md — model, settings, variables, checks,
golden set, everything the release digest covers) differs between the
sealed pin and the observed one, even with its text untouched; for a
workflow slot present in both, the same comparison with `steps` removed
from both sides, plus each step compared the same way by `stepId`; and a
tag present in one copy but not the other. A pin whose settings changed
(an `inference` block edited by hand, say) without its text changing is
therefore named by its tag directly — the member-by-member comparison
sees it even though the text re-hash alone could not.

`brokenAt` on the heartbeat's `seal` member is the instance's own first
observation of a broken store — the moment it first recomputed a mismatch,
held locally so re-checking does not move it. The service stamps its own
receipt time separately; the two may differ, and neither overwrites the
other.

**Drift is reported, never blocking.** A broken seal does not stop the
runtime from rendering what it holds — it is not the runtime's place to
decide the customer's copy is unusable — it is surfaced on the heartbeat
so the fleet view can show it. The one way a store gets back in sync is an
explicit local act: `request_resync` (manifest.schema.json) may *ask* an
instance to re-materialise its store, through the application's own
re-sync hook, but the runtime never overwrites the customer's copy on its
own initiative, on a schedule, or because a heartbeat round trip
suggested it.

## Heartbeat members

Both are optional on `heartbeat.request` (heartbeat.schema.json) and sent
only once the release an instance serves was sealed at protocol ≥ 0.3.5
(the same `protocolAtLeast` gate `catalog.variables` uses at 0.3.4): a
service still at 0.3.4 refuses the whole heartbeat over an unknown key, so
naming a member it cannot understand is worse than staying silent about
it.

* **`pinnedReleaseDigest`** — the seal this instance is pinned to. Absent
  when the instance is following the pointer.
* **`seal`** — `{ sealId, observedDigest, intact, checkedAt, brokenAt?,
  changedTags? }`, the result of the last recomputation above.

## What an implementation must assert

`vectors/seal.json` (generated by `tools/gen_seal_vectors.py`, independent
of the JavaScript reference) fixes a three-slot release — two prompts, one
workflow with two steps — and five cases every implementation of the
recomputation rule must reproduce:

1. An intact store: `observedDigest` equals the release digest, `intact`
   is `true`, `changedTags` is empty.
2. A tampered prompt text: `intact` is `false`, `changedTags` names that
   one slot, and `observedDigest` is the digest recomputed with the
   rehashed (mismatching) `contentHash` in place of the pin's.
3. A settings change with the text untouched: `intact` is `false`, and
   `changedTags` names that slot — the member-by-member digest-projection
   comparison attributes a settings-only drift to its tag, even with no
   text tamper to catch it — and `observedDigest` reflects the changed
   pin.
4. A tampered workflow step text: `changedTags` names the **step**
   (`<tag>#<ordinal>`), not the slot.
5. A slot missing from the customer's copy: `intact` is `false`,
   `changedTags` names that slot.

`conformance/reference.mjs`'s `verifySeal` is checked against all five; the
SDKs must agree with it byte for byte on `observedDigest` and exactly on
`intact` and `changedTags`.
