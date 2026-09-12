# Golden sets — verified before activate (5-D, D63)

A prompt's owner writes 1–50 known inputs with the properties a right
answer has. The runtime — or `airprompter verify --golden` on a host that
never calls home — renders each case with the release's own text, asks the
pinned model on the customer's own key, evaluates the expectations on the
answer, and refuses to activate a staged release whose pass rate falls
below the set's floor. Only counts leave the host.

## The reference on the slot

A manifest slot (or an arm override) that carries a golden set names it:

```json
"goldenSet": { "setId": "gs_20260912", "cases": 24, "contentHash": "sha256:…", "byteLength": 5120, "minPassBps": 10000 }
```

The reference is part of the release digest input only when present
(`canonical-json.md`), like `outputChecks`, so a release sealed before the
set keeps its digest. `contentHash` names a **payload**: the runtime fetches
it with the prompt's own payload route, verifies it against the hash and
length like any other (M9/M10 in `trust-chain.md`), stores it encrypted
under the same DEK and AAD, and carries it in an `.apbundle`. Example inputs
are as sensitive as the prompt they exercise; they are content and are
treated as such end to end.

## The payload

`schemas/golden-set.schema.json`. Canonical JSON (`canonical-json.md`) of:

```json
{
  "format": "airprompter-golden-set", "version": 1,
  "setId": "gs_20260912", "minPassBps": 10000,
  "cases": [
    { "caseId": "billing-refund",
      "variables": { "ticket_body": "I was charged twice, please refund one" },
      "expect": [
        { "kind": "enum", "name": "category", "path": "category", "values": ["billing", "shipping", "other"] },
        { "kind": "must_not_match", "name": "no-guarantee", "pattern": "refund guaranteed", "flags": "i" }
      ] }
  ]
}
```

- `caseId`: lowercase segments joined by `.`, `_` or `-`; unique per set.
- `variables`: values for the slot's declared variables. Every required
  variable is present; nothing undeclared (the console refuses both).
- `expect`: 1–8 expectations in the output-check grammar (`checks.md`):
  `json_schema`, `enum`, `length`, `must_match`, `must_not_match`. Names
  unique per case. A case passes when every expectation passes.
- `minPassBps`: the pass-rate floor in basis points; 10000 (every case)
  unless the author lowers it.

## The run

For each slot with a set — the top-level slot on arm `none`, and each arm
override on its arm — the runtime:

1. renders the slot's text with the case's variables, with the same
   trust-aware fencing `prompt().render()` applies (an end-user value is
   fenced; a required variable missing is a failed case);
2. asks the customer's model through the call the application supplied
   (`golden.invoke` at start; `--run <command>` or `--outputs <file>` on the
   CLI) — the SDK never talks to a provider itself;
3. evaluates the case's expectations on the answer with the output-check
   evaluator (`checks.md`; a provider-reported output token count feeds a
   length band, else `ceil(bytes / 4)`);
4. counts. A render or call that throws is a failed case reported by the
   error's class, never its message.

`passBps = floor(passed / cases × 10000)`; the set is met when
`passBps ≥ minPassBps`. A release is met when every set it carries is.

## What leaves the host

- **`goldenPass`** on the arm's window: one boolean per case, the same
  dimension set the prompt's runs use (`tag`, `versionId`, `arm`, `model`),
  with no `count` (a golden run is not a run). The rollout reads pass counts
  per arm from it. `goldenPass` is reserved in the feedback catalogue: the
  runtime writes it, `ap.feedback()` refuses it (`reserved_name`), `custom`
  cannot shadow it.
- **The apply decision.** On stage, before the apply policy is consulted: a
  release below the floor stays staged — under `auto` as under
  `unlock_required` — with `golden_set_failed` in the log (tag, arm, counts,
  floor) and `status().golden` carrying the counts. An operator's `unlock`
  still activates it deliberately. Without a model call configured the sets
  ride the release unrun and `ap.golden()` runs them on demand.
- Nothing else. Rendered prompts, answers, failed values and the judge's
  reasoning stay on the host.

## The customer-side judge (`ap.judge`)

`ap.judge(runRef, output, rubric, invoke)` runs a rubric on the customer's
own model and files only the score: `rubric` is a criteria list, one of the
templates (`protection` — the five criteria the hosted judge applies to
every sample; `helpfulness`), or `prompt` — the `## Success criteria`
section of the prompt the run rendered, read the way the hosted judge reads
it (list markers stripped, at most seven, each at most 300 characters). The
judge prompt numbers the criteria, fences the output in `<answer>` (a
closing fence inside the output is escaped) and asks for one verdict per
criterion as one JSON line. The score is the share of resolved task
criteria that passed, in [0, 1] → `judgeScore` on the run's arm window
through `ap.feedback()`; a failed protection criterion → `flagged`;
anything unparseable is `unclear`, never a pass.

## Conformance

`vectors/manifest-verify.json` carries a slot with a golden set: the
reference changes the release digest, the payload verifies like any other,
and a set whose payload was not fetched is `payload_missing`.
`vectors/feedback.json` pins `goldenPass` as reserved.
