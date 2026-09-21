# Pinning a runtime to a named release

Most runtimes follow the pointer: whatever your organization promotes to
an environment is what the next sync serves. Sometimes that is not what
you want — a canary host that must stay on a known-good release while you
promote past it, a long-running batch job that should not change mid-run,
a compliance snapshot you want to be able to name later. **Pinning** lets
one runtime render one specific, already-approved release by name, while
everything else about how it behaves keeps coming from your live
environment.

## What a pin is

A release's identity is its digest, and a **seal id** is a short, stable
name for that digest — the first twelve hex characters, good enough to
put in a URL, a config value, or a support ticket, and long enough that
guessing one is not practical. When you pin a runtime to a seal id (or the
full digest), it fetches, verifies and renders exactly that release for
as long as the pin is in place, regardless of what your organization
promotes afterward.

From code:

```ts
// TypeScript
const ap = await AirPrompterAgent.start({
  ...,
  release: "a3a20ff4f7fb", // a seal id, or the full "sha256:..." digest
});
```

```python
# Python
ap = AirPrompterAgent.start(
    ...,
    release="a3a20ff4f7fb",  # a seal id, or the full "sha256:..." digest
)
```

From the command line, on a host that runs the standalone tool:

```sh
airprompter pin a3a20ff4f7fb --agent <agent> --environment prod
```

A pin written this way is read the next time the runtime starts — it does
not reach a process that is already running. Restart the process (or the
service that owns it) to have it take effect. Pinning from the console is
coming in a later release; for now, pin from code at start-up or from the
command line before a process starts.

The pin persists locally, so a restart resumes the same pin without you
having to name the release again. `ap.unpin()` (or `airprompter unpin`)
removes it: the runtime resumes following the pointer, and the release it
had been pinned to is never mistaken for a step backwards once it does.

## Content pinned, control live

A pin is a statement about **what runs**, not about whether your
environment still has a say. While pinned, a runtime:

- renders exactly the pinned release's prompts, models and settings;
- still obeys everything that is not part of a release — a freeze, a
  lease, a request to unlock, a request to re-sync. Your organization's
  live controls reach a pinned runtime the same as any other.

Put differently: you can hold a release still without giving up the
ability to pause it, expire its lease, or ask it to check in.

## The mirror: your own copy of a release

Some applications want a copy of a release's content that lives in their
own systems — a configuration row, a database table, a file that ships
with their own deployment — rather than only inside the runtime's local
storage. A **mirror** is exactly that: a place you own that the runtime
writes to once, reads from afterward, and checks against on every
routine pass.

You supply a small port with a `read` and a `write`; the runtime does the
rest — write the release the first time (or whenever your store comes
back empty), render from what is there once it exists, and recompute
whether it still matches what was written on every pass. It never
rewrites your copy just because a check found it different: a broken
match is reported, not repaired behind your back. The one way your copy
gets rewritten deliberately is an explicit call your own code makes,
naming who approved it.

```ts
// TypeScript — a JSON file as the mirror's home
import { readFile, writeFile } from "node:fs/promises";

const port = {
  async read() {
    try {
      return JSON.parse(await readFile("./release-mirror.json", "utf8"));
    } catch {
      return null; // nothing written yet
    }
  },
  async write(copy) {
    await writeFile("./release-mirror.json", JSON.stringify(copy));
  },
};

const handle = ap.mirror(port);
// Later, after your own admin flow approves a re-sync:
await handle.resync({ approvedBy: "ops@example.com" });
```

```python
# Python — a JSON file as the mirror's home
import json
from pathlib import Path

path = Path("release-mirror.json")

class FileMirrorPort:
    def read(self):
        try:
            return json.loads(path.read_text())
        except FileNotFoundError:
            return None  # nothing written yet

    def write(self, copy):
        path.write_text(json.dumps(copy))

handle = ap.mirror(FileMirrorPort())
# Later, after your own admin flow approves a re-sync:
report = handle.resync(approved_by="ops@example.com")
```

## What drift looks like

Every routine pass, the runtime rehashes what your mirror holds and
compares it against what was written. If your copy still matches, nothing
is reported beyond "still intact." If it does not — hand-edited, partially
restored from a backup, or simply stale — the runtime reports which named
entries changed, never the content itself, on its regular status report;
your fleet view shows it as "seal broken since" the moment it was first
observed, and clears the moment it heals. The runtime keeps serving what
it holds either way — a broken mirror is never treated as a reason to stop
rendering.

## Re-sync is always an explicit act

Nothing here ever rewrites your mirror on a schedule or because a routine
check found a mismatch. The only two writes are: the very first time
(materialising a copy that was empty), and a deliberate call from your
own code that names who approved it — whether that is a person clicking a
button in your own admin tool, or an automated policy you wrote yourself.
Your environment can *ask* a pinned runtime to re-sync (a request your
fleet operator can send), but asking never forces the write; your own
code decides when and whether to act on it.

## Unpinning

Removing a pin returns a runtime to following the pointer. The next
release it picks up under that pointer is never treated as a step
backwards, even if the pointer moved ahead of the pin while it was in
place — unpinning is defined to catch up cleanly, not to trigger a
rollback warning.
