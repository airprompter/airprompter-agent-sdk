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

Only then does apply policy run (`auto` activates; `unlock_required` stages).

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
