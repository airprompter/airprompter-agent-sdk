# Change-control integration recipes

AirPrompter stages; **your side activates**. Under `unlock_required` a
verified release lands in the inactive slot, encrypted, reported as
`staged` in the fleet view, and goes live only through one of three things
your side holds: an operator's `airprompter unlock`, an update window, or
your own hook. AirPrompter can *request* an unlock (a signed, expiring
directive rides the next manifest, and your hook receives it as
`staged.unlockRequest`); it can never grant one. The recipes below are the
hook's shapes. None of them tells AirPrompter which tool you use.

The policy itself is yours too (S4): the first update a host verifies
pins its apply policy in `store.json`; a later update from the console can
make the host *wait for an unlock* but can never switch it back to
*applying automatically* — that takes `airprompter policy set … auto` on
the host (or `ap.setApplyPolicy("auto")`), an operator's act that is logged
with who asked. The fleet view says "pinned on the host" while the
console's setting is advisory there.

The rule every recipe obeys: **resolve after `activate()` to go live;
resolve or reject without it to leave the release staged.** A hook that
throws leaves the release staged and says so in the log
(`on_staged_hook_rejected`) — never activated by accident.

## 1. A ticketing gate (ServiceNow, Jira, Linear — anything with an API)

```ts
const ap = await AirPrompterAgent.start({
  …,
  apply: {
    onStaged: async (staged) => {
      const change = await changeControl.open({
        title: `AirPrompter release generation ${staged.generation}`,
        description: staged.unlockRequest?.note ?? "staged by the control plane",
        requestedBy: staged.unlockRequest?.requestedBy,
      });
      // Poll or subscribe; return without activate() to leave it staged for a later unlock.
      if (await changeControl.approved(change.id, { timeoutMs: 6 * 3600_000 })) staged.activate();
    },
  },
});
```

```python
def on_staged(staged: StagedRelease) -> None:
    change = change_control.open(title=f"AirPrompter release generation {staged.generation}", requested_by=(staged.unlock_request or {}).get("requestedBy"))
    if change_control.approved(change.id, timeout_s=6 * 3600):
        staged.activate()

ap = AirPrompterAgent.start(..., apply=ApplyOptions(on_staged=on_staged))
```

When the ticket is approved after the hook returned, an operator runs
`airprompter unlock --agent … --environment prod --generation N` on the
host (or `ap.unlock()` from any process on it — host-wide in daemon mode),
or the next update window activates it.

## 2. An update window with an out-of-hours veto

```ts
apply: {
  window: "02:00-04:00 Europe/Berlin sat,sun",   // a local window wins over the console's
  onStaged: async (staged) => {
    if (freezeCalendar.isFrozen(new Date())) throw new Error("change freeze");  // stays staged; logged
  },
}
```

The window is a standing approval: everything that verifies goes live
inside it. The hook is the exception path. The console shows both
(`window` and the hook name on the environment).

## 3. CI as the operator (a pipeline unlocks after its own checks)

```bash
# after the pipeline's smoke tests against the staged release pass:
airprompter status  --agent … --environment prod --json | jq -e '.staged.verified == true'
airprompter verify  ./state --org … --agent … --environment prod --root ./root.jwk.json --golden --run "./golden-model.sh"
airprompter unlock  --agent … --environment prod --generation "$GENERATION"
```

`verify --golden` runs the release's golden sets against your model
before the unlock and refuses below their floor; `--run` receives each
case as JSON on stdin and prints the answer.

## 4. Golden sets as the gate itself

Start with a model call and every staged release rehearses its golden sets
**before** the apply policy is consulted; a release below its floor stays
staged — under `auto` too — until an operator unlocks it deliberately.

```ts
golden: { invoke: async ({ text, model }) => (await openai.chat.completions.create({ model, messages: [{ role: "user", content: text }] })).choices[0].message.content ?? "" },
```

`status().golden` carries the counts; `golden_set_failed` names the set,
the arm, the passes and the floor in the log. See
`protocol/golden-sets.md`.

## 5. Countersign (cryptographic acceptance)

On a `requireCountersign` target the runtime refuses any release digest
your countersign key did not sign — a hostile publisher, or a compromised
AirPrompter account, cannot get past it. The ceremony (sign the digest the
console shows with your key, upload the countersignature) is the
customer's; the runtime side is `countersignRoot` / `requireCountersign`
at start, and the CLI's `verify` reports `countersign_missing` until the
signature is present. The signing tool ships with T10.

## 5b. A rollout is one unlock (S9)

Under `unlock_required` a staged rollout used to be one unlock per step.
Now the whole ramp rides the manifest as a signed plan — "5 % from 02:00,
25 % from 03:00, 50 % from 05:00, everyone from 09:00" — and your side
unlocks it **once**; every host walks it on its own clock with no
check-in, an offline host included. The console shows the plan in those
words at unlock; `ap.status().ramp` shows where a host is on it. If a
window's checks fail, the scheduler **retreats** (`disable scope: "arm"`
on the candidate): that is a reduction, so it lands without an unlock and
everyone is back on the control within one heartbeat (S3). Moving share
up outside the plan is a new plan — a new generation, which waits for
your unlock like any release.

## 6. Freeze and rollback

- **Freeze** (console): a signed `disable` directive rides the next
  manifest and is honoured from any manifest whose signature verifies —
  before staging or anti-rollback decide anything — so a frozen fleet
  stops rendering even when nobody unlocks.
- **Rollback**: `airprompter rollback` / `ap.rollback()` flips to the
  other slot instantly. Below the stored generation it is a forced
  downgrade, stamped in the store and on the spool, and the control
  plane's current generation is held back until something newer is
  promoted. A server-side rollback is a **new** generation pointing at an
  older release, so anti-rollback never blocks it.

## 7. Bundles in git (the pull request is the review)

A team that vendors the release beside the code gets change control from
the repository itself (S7). CI pulls the current release into the bundle
and opens a pull request; the reviewer reads what changed, never the
prompt text; on merge, every host stages the new bundle at its next start
and the host's own apply policy decides; a revert is refused.

```bash
# CI, on a schedule: refresh the vendored bundle and open a PR when it moved
AIRPROMPTER_AGENT_KEY=… airprompter pull --org org_… --agent agt_… --environment prod \
  --root ./airprompter-root.jwk.json --root-url https://<edge>/roots/prod/root.json \
  --distribution-key ./prod.pub.json --out airprompter.bundle.apbundle
git diff --quiet -- airprompter.bundle.apbundle || gh pr create --title "AirPrompter release" --body "$(
  airprompter diff airprompter.bundle.apbundle --against "$(git show origin/main:airprompter.bundle.apbundle > /tmp/main.apbundle && echo /tmp/main.apbundle)" \
    --org org_… --agent agt_… --environment prod --distribution-key ./prod.key.json
)"

# the PR check: a bundle that goes backwards is named as such (the runtime would refuse it on every host)
airprompter diff airprompter.bundle.apbundle --against /tmp/main.apbundle --org … --agent … --environment prod --json | jq -e '.direction != "backward"'
```

What the runtime does with the merged bundle: at its next start it opens
and verifies it through the same chain as OTA; a newer generation is
**staged** and the host's apply policy decides (`auto` activates it,
`unlock_required` stages it for `airprompter unlock`, the update window,
or the `onStaged` hook — the recipes above apply unchanged); the held
generation changes nothing; an older one — `git revert` — is refused with
`vendored_bundle_refused: generation_rollback` and the sentence *a
rollback is `airprompter rollback`, never an older bundle*; the host keeps
serving what it holds and its heartbeat says `refused`. `airprompter
apply` of an older file says the same. A bundle stored in a database
column behaves identically — and every reader of that column holds the
distribution key, so the column is as sensitive as the key.

## 8. Live sync while you edit (`airprompter dev`, S12)

A team whose prompts live in git wants the runtime to follow the working
tree, not a release. `airprompter dev ./prompts` serves the directory as a
registry over the protocol's own routes — the manifest, the payloads, the
heartbeat, the catalogue, the edge pointer and the root — signed with a
dev key under a dev root it makes once and keeps beside the prompts
(`.airprompter-dev/keys.json`, mode 0600; `root.pub.json` is what a client
pins). Every save that changes the release is a new generation; an
unchanged save is not; a file that does not parse is reported and the last
good generation keeps serving. An SDK, a daemon or the CLI syncs from it
exactly as from the hosted service, and the same chain applies: a manifest
signed here never verifies against a production root.

```bash
airprompter dev ./prompts --port 4180                # generation 1; every save is generation + 1
AIRPROMPTER_AGENT_KEY=apa_dev_local node app.js       # the SDK: baseUrl http://127.0.0.1:4180, root ./prompts/.airprompter-dev/root.pub.json
airprompter dev ./prompts --apply-policy unlock_required --daemon
```

Change control is honoured on the laptop too: with `release.json`'s
`applyPolicy: "unlock_required"` (or `--apply-policy`), every generation is
staged by the clients and waits for `airprompter unlock` on the host, the
update window or the hook — the same flow as production, so a team can
rehearse its recipe before a release carries it. With `--daemon`, an
embedded `airprompterd` attached to the server serves the host's SDKs over
the local socket, and every promotion reaches them as a `generation`
event within one poll (S3). A file's front matter names the slot's
`model:`, `variables:` (`name!` required, `name?` end-user text — fenced
exactly as in production; without the line every `{{placeholder}}` is an
optional operator variable) and `version:`; `release.json` carries the
manifest's policy, lease, window, experiment and directives.

The same server is the **conformance target**: `node conformance/live.mjs
--base-url … --root … --api-key …` exercises a running registry — `dev`,
Hangar (a self-hosted registry), or the hosted service with a real key —
with the protocol's schemas and trust chain: every route's status, ETag
and refusal, the manifest verified against the root the caller pins, every
payload fetched and hashed, the heartbeat's answer. CI runs it against
`airprompter dev` on every push; the hosted service is checked the same way.

## What the heartbeat tells AirPrompter

`applyState` (`active`, `staged`, `awaiting_unlock`,
`awaiting_countersign`, `refused`, `vendored_fallback`), the active and
staged generations, the refusal reason, `storageProtection`, the model
catalogue, the lease state, spool depth. Nothing about *why* your hook
declined — that stays in your log.
