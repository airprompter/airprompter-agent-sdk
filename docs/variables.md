# Variables from your system

A prompt's text carries `{{name}}` placeholders; the slot declares each one
(`name`, `required`, `trust`). Until now every value came from the call
site, so adding `{{customer_tier}}` to a version meant changing application
code before that version could be promoted. **Variable sources** (SDKs
0.2.10+) let the application say once how a value is found in its own
system; every version that uses the variable is then filled at render time
with no change where the prompt is rendered — and a version that does not
use it never causes the lookup.

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

```python
ap = AirPrompterAgent.start(..., variables={"brand": "Acme", "customer_tier": VariableSource(resolve=tier_of, trust="operator")})
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
3. **nothing** — a required variable is then `MissingVariableError` (the
   render refuses; that is your bug, not an empty string in a prompt).

`render()` is synchronous and uses literals only; if a callable source
would be needed it throws `VariableSourceRequiredError` naming the
variables — use `renderAsync()`. Sources run concurrently, each under its
own timeout and byte bound (64 KiB by default). A source that throws, times
out, answers more than its bound, or answers nothing for a required
variable is `VariableSourceError { tag, variable, reason }`. The runtime
logs `variable_source_failed { tag, name, reason }` — the name, never the
value or the cause's text — and writes one content-free error row
(`render_missing_variable`) so the board shows a version this host cannot
render.

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

`needs(values)` takes the values your call site will pass and returns what
would still be missing; run it at start-up for every slot you render.
`status().variables.unsourced` is the same answer per slot without knowing
your call site — every required name no source fills — across the slot's
text and every experiment arm's override, since a subject may land on any
arm. Names only, never values.

## Workflows, managed mode, golden sets

- **Workflow steps** in client mode are handed back as raw text; `const flow = ap.workflow(tag)` now also has
  `flow.renderStepAsync(stepId, values)`, which fills a step with the same precedence — each step scanned on its own,
  so a source is called for the step that uses the variable and not for the one that does not. A source sees the
  step id (`docs.flow#2`) as its `tag`.
- **Managed mode** (`ManagedAgent`, the hosted `/run` route) runs in your process, so `ManagedAgent.start({ variables })`
  fills required declared variables before the run is posted, and `agent.needs(tag, values)` answers the same
  question. The catalogue names declarations, not text, so "used in the text" cannot be known there: required ones are
  filled, optional ones are not. A hosted run fences by the slot's declaration alone, so an `end_user` source for a
  variable the slot declares `operator` is refused rather than sent raw — declare the variable `end_user` in
  AirPrompter. The provider-compatible endpoints have no process of yours in the path: call-site values only.
- **Golden sets** run before activation, possibly in the CLI, and must be deterministic: they never consult sources.
  A golden case carries every value it needs.
- **Fleet runtimes and vendored bundles**: sources are in-process registration and do not care where the release came
  from.

## Coming next

Protocol 0.3.4 adds `default` and `source: caller | runtime` to a slot's variable declarations, a Slots-page editor
for them, and a seal-time check that every placeholder in the pinned version's text is declared; the heartbeat then
reports the names a runtime can fill so a promotion warns "uncovered on 0 of 4 instances" before it happens.
