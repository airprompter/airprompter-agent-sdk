# Store format — `store.json` and the N/N-1 rule

`store.json` is the host's record of what it holds: the active and staged
slots, the generation, the accepted root document, the wrapped store key
and, from format 2, the apply-policy pin (S4) and the writer. It sits at
`<state>/airprompter/<agentId>/<target>/store.json` beside the two slots
(`slots/A`, `slots/B`: a signed manifest and encrypted payloads each) and
the spool. No prompt text is ever in it.

It is a **cross-package contract** (S8): `airprompterd` — the daemon
binary — writes it, and the application's SDK reads it, and the two
deploy on different days. Once the SDK ships as separate packages
(`@airprompter/agent-core` reads, `airprompter` writes) the format is the
seam between them, so it carries a version and a rule.

Status: **format 2** (`schemas/store.schema.json`; examples
`examples/store.v1.json`, `examples/store.v2.json`).

## The N/N-1 rule

A reader at format **N**:

1. **accepts N and N-1** — a file written by the previous format opens as
   it was written; a field the older format lacks is simply absent (the
   pin, the writer);
2. **writes N** — every write is in the reader's own format;
3. **migrates an N-1 file forward on its first write, never on open** —
   opening a store changes nothing on disk, so a writer upgraded and then
   rolled back before it wrote anything still finds the file it can read
   (**the N-1 read window is the rollback path**: bump readers first,
   writers last; roll writers back first);
4. **refuses N+1 with `store_newer`, naming the writer** — the file's
   `writer` (name and version) is in the error and its detail, so the
   operator knows which package to update (or roll back before its next
   write). The file is never touched, never guessed at.
   `AirPrompterAgent.start` raises `AgentStartError("store_newer")`.

A format bump is therefore a two-step deploy: readers first (they accept
both), writers last (they write the new one). Breaking a field's meaning
without a bump is not allowed; adding an optional field is a bump.

## Format 2

| Field | Type | Meaning |
|---|---|---|
| `version` | `2` | the format |
| `writer` | `{ name, version }` | the package that last wrote the file (`agent-sdk-typescript 0.1.0`, `agent-sdk-python 0.1.0`, `airprompterd 0.1.0`, `airprompter-cli 0.1.0`) |
| `agentId`, `target` | | the scope; a file for another agent or target is `store_corrupt` |
| `instanceId` | | the **store's** identity (S6): the seed of the `runRef` key every process on the host shares; never a process's instance id |
| `wrappedDek` | base64url | the store key, wrapped by the key provider (`key-handling.md`) |
| `storageProtection` | enum | how the key is held: `os_keystore`, `kms`, `vault`, `custom`, `file_key` |
| `active`, `staged` | `A` / `B` / `null` | the serving slot and the verified-but-not-activated one |
| `generation` | integer | what `active` holds; anti-rollback compares against it |
| `root` | key-set / `null` | the last accepted root document |
| `forcedDowngrade` | boolean, optional | a local `rollback --force` stamped on evidence |
| `heldBackBelow` | integer, optional | a local rollback stepped down from this generation; sync holds it (and older) back until the control plane moves past it |
| `applyPolicyPin` | object, optional | S4: `{ value, source: manifest \| operator, generation, setAt }` — the apply policy this host holds |
| `updatedAt` | timestamp | the last write |

Format 1 (0.2.0–0.2.5) is format 2 without `writer` (and, in practice,
without the pin). Format 1 files are read by every current reader and
rewritten as format 2 on their first write.

## Vectors

`sdk-typescript/test/storeFormat.test.ts` and
`sdk-python/tests/test_store_format.py` open the protocol's two examples
and a format-3 file: N-1 opens unchanged and migrates on first write with
the writer named; N opens as written; a fresh store is written at N; N+1
is refused with `store_newer` naming the writer (and "an unknown writer"
for a hand-edited file), and the runtime's start says the same. The
conformance run validates both examples against `store.schema.json` and
refuses a format-3 file, a format-2 file without its writer, and a file
with a free-form member.
