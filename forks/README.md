# Agent SDK forks

We keep a copy of each agent framework and provider SDK that this repository integrates with, in the `airprompter`
org. There are twelve public forks and two private mirrors, listed in [`forks.json`](forks.json). They are a
reference and a fallback only. Customers install from npm and PyPI, so a fork does not stop an upstream release
from reaching a customer: the SDK's peer ranges and [`wrap-latest.yml`](../.github/workflows/wrap-latest.yml) do
that. We never change the forks' code. Shipping a patch from one would be a new owner decision.

| Kind | Repositories |
|---|---|
| Public forks (Actions, issues, wiki and projects off) | `langchainjs`, `langgraphjs`, `openai-node`, `anthropic-sdk-typescript`, `vercel-ai`, `openai-agents-js`, `langchain`, `langgraph`, `openai-agents-python`, `pydantic-ai`, `openai-python`, `anthropic-sdk-python` |
| Private mirrors (Actions off; no fork link; `ee/LICENSE` and `enterprise/LICENSE.md` forbid redistributing those folders) | `mastra`, `litellm`. **Never make either public.** |

## Tracking upstream

[`sync-forks.yml`](../.github/workflows/sync-forks.yml) runs daily at 05:41 UTC and on demand. The forks' own
Actions stay off. It runs [`scripts/forks/sync.mjs`](../scripts/forks/sync.mjs), which does the following:

- **Default branch, fast-forward only.** Upstream's branch and ours are fetched, and upstream's is pushed without
  force. This works the same way for forks and mirrors. A branch that has diverged is refused and reported, never
  merged. GitHub's `merge-upstream` is not used because it would write a merge commit. A private mirror that has
  turned public is not pushed to.
- **Tags.** Every upstream tag we lack is added. Ours are never overwritten or deleted:
  - When upstream moves a tag or deletes one, the run reports it and keeps ours.
  - That repository gets no new tags until someone checks the change and acknowledges it under
    `acknowledgedTagChanges` as `{ "tag": …, "upstream": "<the commit upstream now names>" }` (or `null` for a
    deletion). An acknowledgement covers that one change: if the tag moves again, the run reports it again.
  - A floating pointer that moves on every build (a nightly, `*-bleeding`) goes under `ignoreTags`. It is never
    copied, compared or reported. pydantic-ai's `clai2-bleeding` is the one there today.
  - A tag counts as moved only when the commit it names changes, so re-creating an annotated tag on the same commit
    is not reported.
- **`compat/*`** tags are ours and the sync never touches them.

Try it without a token: `node scripts/forks/sync.mjs --dry-run` plans the public forks and pushes nothing.

**Owner setup, once, before merging.** Until this is done, the daily run fails every night at its "Sync" step,
and GitHub emails whoever last edited the cron line.

1. Allow fine-grained tokens on the `airprompter` org. If the org requires approval, an org owner approves the
   token.
2. Create a fine-grained token:
   - **Resource owner:** `airprompter`.
   - **Repositories:** "Only select repositories", then all fourteen above, including the private `mastra` and
     `litellm`.
   - **Permissions:** **Contents: read and write** and **Workflows: read and write**. Metadata: read is added
     automatically. Workflows access is needed because a fast-forward can bring upstream's own
     `.github/workflows` changes.

   The person who creates it needs write access to all fourteen.
3. Give it an expiry, up to 366 days, and set a reminder to rotate it. The token belongs to that person: if they
   leave the org, the sync and the compat tagging stop.
4. Add it as the repository secret `FORK_SYNC_TOKEN` on `airprompter/airprompter-agent-sdk`.
5. Check it:
   1. Run **Sync the agent SDK forks** with `dry_run` on.
   2. Run it for real with `only: airprompter/vercel-ai`. That is the largest first run: 1,856 tags, in batches of
      200.
   3. Run it with no `only`.

## When the sync fails

Open the run summary, or the `fork-sync-report` artifact, which lists both commits for each moved tag.

- **Moved or deleted upstream.** That repository is paused: it gets no new tags until someone decides. Compare
  `https://github.com/<upstream>/compare/<ours>...<theirs>`.
  - **A floating pointer** (a nightly, `*-bleeding`, `latest`): in a PR, add it to that repository's `ignoreTags`,
    with a line in `$ignoreTags` saying what you saw and when.
  - **The same release re-tagged:** add the `{ "tag", "upstream" }` pair that the run's note prints to
    `acknowledgedTagChanges`.
  - **A release tag that now names different code, or was deleted:** tell the owner before acknowledging it, and
    check whether a `compat/*` tag on that fork names the old commit. Ours stays as it was either way.
  - After the PR merges, run the workflow with `only: airprompter/<repo>`.
- **"not a fast-forward" on the default branch.** Our branch has a commit upstream lacks, or
  upstream rewrote its history. Do not force-push: the forks' code never changes without an owner decision.
- **HTTP 401 or 403, or "Repository not found".** `FORK_SYNC_TOKEN` has expired or is missing that repository. See
  Owner setup.
- **compat-tags: "no upstream tag on our fork yet".** The release tested a version newer than the last sync. Run
  the sync for that repository, then re-run the release's `compat-tags` job. Tags it already created show as
  `present`.

## A tagged copy of each tested version

When an SDK release publishes, the `compat-tags` job in [`release.yml`](../.github/workflows/release.yml) runs
[`scripts/forks/compat-tags.mjs`](../scripts/forks/compat-tags.mjs) `--apply`. It tags each fork at the version
that release tested, as `compat/<sdk version>`:

- **The tested version** is read from the release tag itself: `testedVersionFrom` in `forks.json`, today
  `sdk-typescript/package-lock.json` at `sdk-typescript/v<version>`.
  - A package that the release did not install gets no tag.
  - A package with no pinned tested version gets no tag either. That is every Python one today, because Python CI
    installs no framework or provider client. Only the weekly `wrap-latest` run installs them, at `@latest`.
- **The commit** is the one that the upstream's own tag for that version names on our fork, such as
  `langchain@1.6.1` or `v7.50.0`. If a monorepo released its tested packages from different commits, each package
  gets `compat/<sdk version>/<package>` instead. That is the one departure from the ticket's single name. Git
  cannot hold both forms for one version, so a clash is a conflict.
- **Tags are lightweight and never move.** If a compat tag already exists on another commit, the run fails and
  creates nothing. It also fails when a tested version's upstream tag has not reached our fork yet, rather than
  skipping it quietly.

To see the plan for a release, with no token needed:

```bash
node scripts/forks/compat-tags.mjs 1.0.0-rc.4
```

### Tags for 1.0.0-rc.4 (planned 2026-11-27, not pushed)

| Fork | Tag | Tested | Commit |
|---|---|---|---|
| `airprompter/langchainjs` | `compat/1.0.0-rc.4` | `langchain` 1.6.1, `@langchain/core` 1.3.4 (one release commit) | `bb1fe4deb9af41e287343b7ff6f2b68b4db81d27` |
| `airprompter/langgraphjs` | `compat/1.0.0-rc.4` | `@langchain/langgraph` 1.6.1 | `77294a35a56bfdb86e5952158bcb343fc3c41950` |
| `airprompter/openai-node` | `compat/1.0.0-rc.4` | `openai` 7.50.0 (installed through `@langchain/openai`; `wrapLive.test.ts` ran against it) | `42563fe08083ed7af6feba046063e3100fa7ef50` |
| `airprompter/anthropic-sdk-typescript` | `compat/1.0.0-rc.4` | `@anthropic-ai/sdk` 0.129.0 (installed through `@langchain/anthropic`; `wrapLive.test.ts` ran against it) | `bf2058689f845dfb10e59bd9ebeb5cb4e9318a9d` |

rc.4 has already shipped, so no release run will create these. Once the secret exists, create them with:

```bash
git fetch --tags
FORK_SYNC_TOKEN=… node scripts/forks/compat-tags.mjs 1.0.0-rc.4 --registry npm --apply
```

The other ten repositories get no `compat/1.0.0-rc.4` tag:

- **`vercel-ai`, `openai-agents-js` and `mastra`:** the release did not install `ai`, `@openai/agents` or
  `@mastra/core`.
- **The seven Python repositories:** no tested version is pinned for them.

When a Python package gets `testedVersionFrom`, check its `tag` pattern against prerelease versions too. PyPI
writes `0.24.0a7`, but upstreams tag `v0.24.0-alpha.7`, and litellm tags `v1.112.0-rc.1`, `-stable` and
`-nightly`. The pattern may need a version form of its own.

### How a Python version gets certified

This needs a follow-up ticket, and these steps happen in order:

1. Commit the pinned integration versions, for example `sdk-python/tested-integrations.txt` with `openai==…`.
2. Have Python CI install those versions and run the wrapper and adapter tests against them.
3. Add a reader for that file in `scripts/forks/lib.mjs`.
4. Set `testedVersionFrom` on the Python packages.

Until the reader exists, `forks.json` refuses a Python `testedVersionFrom`, because a missing reader would wrongly
read as "not tested".

## Adding a framework

When a new framework joins the epic, take these steps in one PR:

1. Fork it into `airprompter`, or mirror it privately if its licence forbids redistribution. Turn off Actions,
   issues, the wiki and projects, and point the description at upstream.
2. Add the repository to `forks.json`, with `packages`, the upstream's tag pattern and `testedVersionFrom`.
3. Add the repository to `FORK_SYNC_TOKEN`'s repository list.
4. Add the name to the manifest test in `scripts/forks/lib.test.mjs`.
5. Run `node scripts/forks/sync.mjs --dry-run --only airprompter/<new>`, and acknowledge any floating tags in the
   same PR.

A Python package gets no `testedVersionFrom` yet (see above).
