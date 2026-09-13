# Key handling

Six keys touch a Team Agents deployment. Only two are yours to keep
secret on the host — the **distribution private key** and the store's
**key-encryption key** — and both are custody problems the vendor cannot
solve for you. The rest are public halves, revocable credentials, or keys
that never leave AirPrompter.

| Key | Who holds it | What it does | Compromise means | Rotation |
|---|---|---|---|---|
| **Root** (P-256, per environment) | AirPrompter, offline ceremony, split custody; **you pin the public half** | Signs `root.json`, which lists the online signing keys, their validity windows and the threshold | Undetectable manifests — which is why the private half is never online and you pin the public half out of band | A new root is a re-enrollment of every runtime (a pinned key changes). Rare by design. |
| **Signing keys** (P-256, per environment, in AWS KMS) | AirPrompter | Sign every manifest (`ES256` over canonical JSON) | Bounded: the SDK trusts only keys listed in current root metadata, and a compromised key cannot authorize its successor — rotation is a new `root.json` signed by root | Signed root rotation; the SDK refuses keys absent from or expired in the root it holds |
| **Agent key** (`apa_…`, scoped to one agent and one target) | Your runtime / CI, from the environment (`AIRPROMPTER_AGENT_KEY`) — the CLI never takes it on argv | Fetches the manifest and payloads; heartbeats; obtains telemetry grants. Read-only for governance: no API key can seal, promote, unlock or countersign | A stolen key pulls that target's bundle and writes telemetry under its own prefix, until revoked. It cannot read another target, cannot spend the organization's allowance (`agent.run` is a separate key kind) | Overlap rotation in Settings › Keys: mint the second, roll the fleet, revoke the first |
| **Distribution key** (X25519) | You. `airprompter keygen --purpose distribution` writes `prod.key.json` (0600) and `prod.pub.json`; **register the public half** on the environment | Every offline update file (`.apbundle`) and every `pull` output is HPKE-sealed to the registered public key; the private half opens them | The private half is in effect the environment's data-encryption key for updates: whoever holds it and a file reads the prompts in it | At least every 90 days (the update file's default lease): `keygen` a new pair, register the new public key (console-only; nothing is resealed), download a fresh file, retire the old private key once the hosts applied it |
| **Store KEK** | Your host, obtained at boot from a `KeyProvider` | Wraps the DEK under which every payload in the local store is AES-256-GCM encrypted (AAD `agentId target generation contentHash`) | A host attacker who also holds the KEK reads the store. That is the boundary, and it is stated | `SlotStore.rotateKey(provider)` re-wraps the DEK under a new provider without re-encrypting a payload |
| **Countersign key** (P-256, customer root → customer signing keys) | You, entirely; AirPrompter holds only the public root | On a `requireCountersign` target the runtime refuses any release digest your key did not sign — including every rollout arm's | A stolen countersign key lets a hostile publisher's release be countersigned; it never lets AirPrompter sign for you | Your own ceremony, the same TUF shape as the platform root |

## Where each secret must never be

- **The Agent key** never inside a bundle, a manifest, a spool row or a
  log line; never on argv. The CLI reads it from the environment
  (`--api-key-env` names the variable).
- **The distribution private key** never beside the update file, never in
  a git worktree (`keygen` refuses unless `--allow-worktree`), never on
  the console (only the public half is registered).
- **The KEK** never on disk in the clear. `file_key` (the default for a
  first run) stores it in a 0600 file beside the store and is reported as
  `storageProtection: file_key` on every heartbeat so the fleet view shows
  it as a finding; production hosts use `kms`, `vault`, `os_keystore` or a
  custom provider.
- **The countersign private key** never at AirPrompter. The console can
  show that a release awaits countersign; it cannot supply one.

## Key providers (the KEK)

| Provider | `storageProtection` on the heartbeat |
|---|---|
| file key beside the store, 0600 (default) | `file_key` |
| AWS KMS Encrypt / Decrypt | `kms` |
| HashiCorp Vault transit | `vault` |
| OS keystore (Keychain, Credential Locker, Secret Service) | `os_keystore` |
| your own wrap / unwrap pair | `custom` |

TypeScript: `keyProvider` at start (`fileKey`, `customKeyProvider`);
Python: `key_provider` (`file_key`, `kms`, `vault`, `os_keystore`,
`custom_key_provider`). What protects the KEK is reported, never
verified: a fleet view can ask, a control plane cannot check.

## What a key does not do

- No key hides prompts from AirPrompter (the system of record) — see the
  [threat model](threat-model.md).
- No key protects plaintext from the process that renders it, or from a
  same-user process on the host.
- Signatures make bytes *verifiable*, not *secret*: an unencrypted `dev`
  bundle is readable by anyone who has it and still verifies.
