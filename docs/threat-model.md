# Threat model — stated so nobody sells more than this

This is the threat model of the AirPrompter Team Agents design (revision 7,
2026-09-12, §1), reproduced **verbatim** and then mapped to what this
repository actually does. The two "not defended" rows are part of the
contract: a security review that does not see them has been shown the
wrong document.

## The rows, as written

| Adversary | Can do | Stopped by |
|---|---|---|
| Stolen Agent API key | Pull the target's bundle (read-only) | Prompts are treated as confidential: TLS + at-rest encryption on the client; key revocation ends future pulls; lease expiry degrades stale runtimes; the key can only read *its* agent and target. |
| Compromised AirPrompter account with publisher rights | Compose and promote a release | Governance quorum + ledger (existing); `unlock_required` targets stage only; `requireCountersign` targets refuse anything the customer's release key did not sign. |
| Network attacker (MITM, malicious CDN) | Alter bytes in flight | Signatures on the manifest, SHA-256 on every payload, anti-rollback generation. TLS is defence in depth, not the trust root. |
| Attacker with disk access on the customer host (backups, snapshots, another tenant on the box) | Read the local store | AES-256-GCM per payload; DEK wrapped by a KEK the process obtains at boot from an OS keystore or the customer's KMS; AAD binds ciphertext to agent/target/hash. |
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

## Claim → row → what the code does → what proves it

Every security claim in these docs and the READMEs maps to one row above.
A claim that maps to nothing is not a claim we make.

| Claim (as the docs say it) | Row | Mechanism in this repository | Proof |
|---|---|---|---|
| A key can only read its own agent and target | Stolen key | The heartbeat, manifest and payload routes take the Agent key; the manifest's `organizationId`/`agentId`/`target` must equal the runtime's scope (M6) | `protocol/vectors/manifest-verify.json` "manifest for another organization / agent / staging manifest presented to a prod runtime"; `trust-chain.md` M6 |
| Prompts are encrypted at rest on the client | Stolen key · Disk access | `SlotStore`: AES-256-GCM per payload under a DEK; AAD `agentId target generation contentHash`; the DEK wrapped by a `KeyProvider` (file key, or the customer's KMS) | `sdk-typescript/test/store.test.ts`, `sdk-python/tests/test_store.py`; [key-handling.md](key-handling.md) |
| Revocation ends future pulls; a lapsed grant is refused | Stolen key | Every fetch carries the key; the telemetry grant expires ≤ 15 min and the uploader refuses to post on a lapsed one before any bytes move | `sdk-typescript/test/uploader.test.ts` "a lapsed grant is refused" |
| Lease expiry degrades stale runtimes | Stolen key | `leaseSeconds` in the signed manifest; a runtime that cannot check in marks itself `lease_expired` and degrades or halts per target | `sdk-typescript/test/agent.test.ts` "the lease counts from the last successful contact" |
| A staged release cannot be made live from AirPrompter's side | Compromised publisher | `unlock_required` stages into the inactive slot; activation is a local operator, a local window, or the customer's hook; AirPrompter can only *request* | `sdk-typescript/test/agent.test.ts` "unlock_required stages until unlocked"; [change-control.md](change-control.md) |
| A countersign target refuses anything the customer key did not sign | Compromised publisher · Hostile insider | `requireCountersign`: every release digest (each arm's too) must carry a countersignature under the customer root; the local side may require it even when the manifest does not | `manifest-verify.json` countersign cases (missing / valid / foreign / wrong digest / corrupted / locally required / both arms) |
| Bytes altered in flight are refused | Network attacker | ES256 over the canonical payload; SHA-256 and declared length on every payload; monotonic generation (server rollback is a new generation) | `manifest-verify.json` "payload altered after signing", "signature bytes corrupted", "payload bytes that do not hash", "generation below the stored one" |
| A compromised signing key cannot authorize its successor | Network attacker · Compromised publisher | The SDK pins an offline **root**; root metadata lists the signing keys with expiry; rotation is signed by root; a key absent from current root metadata is unverified | `manifest-verify.json` root cases (stranger, targets-key-as-root, altered, expired, rotation) |
| An offline update file cannot be relabelled to another agent or target | Network attacker | `.apbundle` HPKE with AAD `agentId|target`; decryption under another label fails | `sdk-typescript/test/hpke.test.ts`; `cli/test/cli.test.ts` "another target" |
| Telemetry carries no prompt text, output, or end-user identifier | Hostile insider (what we can read) | The window schema has no field for content; the ingest drops unknown fields; feedback is numbers, booleans and declared enums only; golden runs and judgements report counts only | `protocol/vectors/spool.json`, `feedback.json`; `sdk-typescript/test/golden.test.ts` "never the output"; `spool-format.md` "What must never be in the spool" |
| **We do not defend against process-level access on the host** | Process-level access | Nothing. The process that renders holds the plaintext; a debugger, a core dump, or a same-user process reads it | — (`SECURITY.md`, this page, the one-pager) |
| **We do not hide prompts from AirPrompter** | Hostile insider | Nothing. AirPrompter is the system of record for the prompt text | — (`SECURITY.md`, this page, the one-pager) |
| A host attacker who also holds the KEK reads the store | Disk access (boundary) | Nothing beyond the KEK's own custody — the KEK is the boundary | `SECURITY.md`; [key-handling.md](key-handling.md) |

## What the docs may not say

- That AirPrompter cannot read a customer's prompts.
- That a prompt on a customer host is protected from that host's
  administrators, debuggers or memory.
- That TLS is what makes distribution trustworthy (it is defence in depth).
- That telemetry "is anonymised": it is **content-free by schema**, which is
  a stronger and narrower statement.
