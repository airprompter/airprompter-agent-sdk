# Variables from your system

A prompt's text carries `{{name}}` placeholders; the slot declares each one
(`name`, `required`, `trust`). Until now every value came from the call
site, so adding `{{customer_tier}}` to a version meant changing application
code before that version could be promoted. **Variable sources** (TypeScript
0.2.10; Python 0.2.11) let the application say once how a value is found in
its own system; every version that uses the variable is then filled at
render time with no change where the prompt is rendered — and a version
that does not use it never causes the lookup.

## Registering a source

```ts
const ap = await AirPrompterAgent.start({
  ...,
  variables: {
    brand: "Acme",                                              // a literal: always this, operator trust
    customer_tier: {                                            // a source: your system, asked at render time
      resolve: async ({ subject }) => crm.tierOf(subject),      // undefined = "I have none"
      trust: "operator",                                        // required — see "Trust" below
      timeoutMs: 500,                                           // default 2 s
    },
    last_ticket: { resolve: async ({ subject }) => tickets.latest(subject), trust: "end_user" },
  },
});
ap.variables.provide("region", process.env.REGION!);            // later is fine
ap.variables.revoke("region");
```

Python — the same registry, with the language's own shape:

```python
ap = AirPrompterAgent.start(
    ...,
    variables={
        "brand": "Acme",                                                        # a literal: always this, operator trust
        "customer_tier": {                                                      # a source: your system, asked at render time
            "resolve": lambda ctx: crm.tier_of(ctx.subject),                    # None = "I have none"; a plain callable or a coroutine function
            "trust": "operator",                                                # required — see "Trust" below
            "timeout_seconds": 0.5,                                             # default 2 s
        },
        "last_ticket": VariableSource(resolve=tickets.latest_async, trust="end_user"),   # a coroutine function: render_async() only
    },
)
ap.variables.provide("region", os.environ["REGION"])                            # later is fine
ap.variables.revoke("region")
```

The context a source receives — `{ tag, name, subject, versionId, arm }` —
is content-free: never the prompt text, never other values. A source that
must answer differently for two prompts reads `tag`.

## What a render does

`render(values)` and `renderAsync(values)` fill each declared variable in
this order, and stop at the first that answers:

1. **the call site's value** — the caller knows more than a source;
2. **a registered source** — consulted only for a declared variable that is
   *required or present in the text* and that the call site did not pass;
3. **the declared default** (protocol 0.3.4) — an optional `operator`
   variable may carry one (`airprompter dev` front matter today; AirPrompter's
   Slots › Variables editor with the service's 0.3.4 release); the render uses
   it when nothing above answered. A required or end-user variable never has
   one (the schema refuses it);
4. **nothing** — a required variable is then `MissingVariableError` (the
   render refuses; that is your bug, not an empty string in a prompt). An
   **optional** variable nobody fills renders empty, exactly as it did when
   the call site left it out — so declare a variable required in AirPrompter
   when the prompt cannot do without it, and `needs()` will name it.

`render()` is synchronous and uses literals only; if a callable source
would be needed it throws `VariableSourceRequiredError` naming the
variables — use `renderAsync()`. Sources run concurrently, each under its
own timeout and byte bound (64 KiB by default).

In Python the SDK is synchronous by design, so `render()` *does* run a
plain-callable source — each on a daemon thread of its own, all at once,
under its own timeout measured from the moment the render dispatched it,
the first failure ending the render — and holds none of the agent's locks
while it does; it refuses only
a **coroutine-function** source, with the same
`VariableSourceRequiredError` — use `await ….render_async()`, which awaits
those and runs plain callables on a daemon thread (never the event loop's
default executor, which `asyncio.run()` would wait for at exit). A source
that outlives its timeout keeps its thread until it returns (a thread cannot
be killed); the render has already failed by name, and the interpreter's
exit is never held up by it — bound your own I/O inside the source. A
coroutine source is cancelled at its deadline and the render fails at once,
whether or not the source honours the cancellation; a value it returns late
is never used. A source that throws, times
out, answers more than its bound, or answers nothing for a required
variable, or answers something other than text, is
`VariableSourceError { tag, variable, reason }` (`threw` · `timeout` ·
`too_large` · `empty` · `not_text`). The runtime logs
`variable_source_failed { tag, name, reason }` — the name, never the value
or the cause's text — and writes one content-free error row. That row is
the same `render_missing_variable` class a missing call-site value gets
(the window schema has no class for "a source failed" yet), so on the
board a source outage and a missing variable read alike: this host could
not render the version.

The slot is resolved **before** a source is awaited: a release that
activates while a lookup is in flight does not mix the new generation's
text with the old run reference.

## Trust

A callable source is text nobody in AirPrompter reviewed — a CRM notes
field, a CMS row another team writes. Registering one names its trust, and
a render uses the **stricter** of the prompt's declaration and the source's:

| Prompt declares | Source says | Rendered as |
|---|---|---|
| `operator` | `operator` | raw text |
| `operator` | `end_user` | fenced in the variable's delimiters (`<name>…</name>`), and `variable_source_trust_stricter` is logged once per slot and name |
| `end_user` | either | fenced |

A source can never loosen a declaration. A call-site value is fenced by the
prompt's declaration alone, as before.

## Finding an uncoverable version before the first request

```ts
const missing = ap.prompt("support.triage").needs({ ticket: "" });  // names the call site must still pass
if (missing.length) throw new Error(`support.triage needs ${missing.join(", ")}`);
ap.status().variables;   // { sources: [...names], unsourced: [{ tag, arm, names }] } — per slot and arm, required names no source fills
```

```python
missing = ap.prompt("support.triage").needs(ticket="")
ap.status().variables    # {"sources": [...], "unsourced": [{"tag", "arm", "names"}]}
```

`needs(values)` takes the values your call site will pass and returns what
would still be missing; run it at start-up for every slot you render.
`status().variables.unsourced` is the same answer per slot without knowing
your call site — every required name no source fills — for the slot and
for every experiment arm's override, since a subject may land on any arm.
Declarations only, no payload read. Names only, never values.

## Workflows, managed mode, golden sets

- **Workflow steps** in client mode are handed back as raw text; `const flow = ap.workflow(tag)` now also has
  `flow.renderStepAsync(stepId, values)` (Python: `flow.render_step(step_id, values)` and `render_step_async`), which
  fills a step with the same precedence — each step scanned on its own, so a source is called for the step that uses
  the variable and not for the one that does not. A source sees the step id (`docs.flow#2`) as its `tag`.
- **Managed mode** (`ManagedAgent`, the hosted `/run` route) runs in your process, so `ManagedAgent.start({ variables })`
  (Python: `ManagedAgent.start(variables=...)`; that client is synchronous throughout, so its sources must be plain
  callables — a coroutine function is refused by name) fills required declared variables, and any marked
  `source: runtime` (0.3.4), before the run is posted, and `agent.needs(tag, values)` answers the same question. The
  catalogue names declarations, not text, so "used in the text" cannot be known there: required and `source: runtime`
  ones are filled, other optional ones are not; the context a source sees carries `versionId: null` and `arm: null` (the run route
  resolves them). A hosted run fences by the slot's declaration alone, so an `end_user` source for a variable the slot
  declares `operator` is refused before any lookup (`VariableSourceError`, reason `unfenceable`) rather than sent raw —
  declare the variable `end_user` in AirPrompter, or pass the value from the call site. The provider-compatible
  endpoints have no process of yours in the path: call-site values only.
- **Golden sets** run before activation, possibly in the CLI, and must be deterministic: they never consult sources.
  A golden case carries every value it needs.
- **Fleet runtimes and vendored bundles**: sources are in-process registration and do not care where the release came
  from.

## What the protocol now carries, and what the service will do with it (protocol 0.3.4)

A slot's variable declarations are sealed into the release: `name`, `required`, `trust`, and from protocol 0.3.4
`default` (optional operator variables only; never empty) and `source: caller | runtime` — a statement of who is
expected to fill the variable. In managed mode a `source: runtime` variable is filled from your registered source
before the run is posted, required or not (the catalogue has no text to scan). Every runtime's heartbeat carries
`catalog.variables` — the names `ap.variables.names()` answers, never a value, an empty list when there are none —
once the release it serves was sealed at 0.3.4 (an older service refuses a key it does not know, so the SDK waits
for that signal). A host whose
SDKs attach to `airprompterd` is the exception for now: the daemon heartbeats for them and knows no sources, so it
reports no names — attached SDKs will hand theirs over in `hello` with the service's 0.3.4 release.

What lands with the service's 0.3.4 release, not yet live: the Slots › Variables editor for these fields; a seal
that refuses a version whose text uses a placeholder the slot does not declare (`variable_undeclared`, so a runtime
never renders a literal `{{name}}`); a warning when a `source: runtime` variable is filled by no live instance
("uncovered on 0 of 4 instances", before the promotion, not after); and the hosted run route applying defaults.
