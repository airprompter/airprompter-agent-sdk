# Agent SDK forks

We keep a copy of each agent framework and provider SDK that this repository integrates with, in the `airprompter`
org. There are twelve public forks and two private mirrors, listed in [`forks.json`](forks.json). They are a
reference and a fallback only. Customers install from npm and PyPI, so a fork does not stop an upstream release
from reaching a customer: the SDK's peer ranges and [`wrap-latest.yml`](../.github/workflows/wrap-latest.yml) do
that. We never change the forks' code. Shipping a patch from one would be a new owner decision.

| Kind | Repositories |
|---|---|
| Public forks (Actions, issues, wiki and projects off) | `langchainjs`, `langgraphjs`, `openai-node`, `anthropic-sdk-typescript`, `vercel-ai`, `openai-agents-js`, `langchain`, `langgraph`, `openai-agents-python`, `pydantic-ai`, `openai-python`, `anthropic-sdk-python` |
| Private mirrors (no fork link; `ee/LICENSE` and `enterprise/LICENSE.md` forbid redistributing those folders) | `mastra`, `litellm`. **Never make either public.** |

## Tracking upstream

[`sync-forks.yml`](../.github/workflows/sync-forks.yml) runs daily at 05:41 UTC and on demand. The forks' own
Actions stay off. It runs [`scripts/forks/sync.mjs`](../scripts/forks/sync.mjs), which does the following:

- **Default branch.** A fork is fast-forwarded with GitHub's `merge-upstream`. A mirror is fetched from upstream and
  pushed without force. A branch that cannot fast-forward is reported.
- **Tags.** Every upstream tag we lack is added. Ours are never overwritten or deleted:
  - When upstream moves a tag or deletes one, the run reports it and keeps ours.
  - That repository gets no new tags until the change is checked and its tag is listed under
    `acknowledgedTagChanges` for the repository.
  - A tag counts as moved only when the commit it names changes, so re-creating an annotated tag on the same commit
    is not reported.
- **`compat/*`** tags are ours and the sync never touches them.

Try it without a token: `node scripts/forks/sync.mjs --dry-run` plans the public forks and pushes nothing.

**Owner setup, once.** Add the repository secret `FORK_SYNC_TOKEN` to `airprompter/airprompter-agent-sdk`. Use a
fine-grained token on the `airprompter` org with **Contents: read and write** and **Workflows: read and write** on
the fourteen repositories above. Workflows access is needed because a fast-forward can bring upstream's own
`.github/workflows` changes. Until the secret exists, the scheduled run fails at its first step and says so.

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
  gets `compat/<sdk version>/<package>` instead.
- **Tags are lightweight and never move.** If a compat tag already exists on another commit, the run fails and
  creates nothing.

To see the plan for a release, with no token needed:

```bash
node scripts/forks/compat-tags.mjs 1.0.0-rc.4
```

### Tags for 1.0.0-rc.4 (planned 2026-11-27, not pushed)

| Fork | Tag | Tested | Commit |
|---|---|---|---|
| `airprompter/langchainjs` | `compat/1.0.0-rc.4` | `langchain` 1.6.1, `@langchain/core` 1.3.4 (one release commit) | `bb1fe4deb9af41e287343b7ff6f2b68b4db81d27` |
| `airprompter/langgraphjs` | `compat/1.0.0-rc.4` | `@langchain/langgraph` 1.6.1 | `77294a35a56bfdb86e5952158bcb343fc3c41950` |
| `airprompter/openai-node` | `compat/1.0.0-rc.4` | `openai` 7.50.0 | `42563fe08083ed7af6feba046063e3100fa7ef50` |
| `airprompter/anthropic-sdk-typescript` | `compat/1.0.0-rc.4` | `@anthropic-ai/sdk` 0.129.0 | `bf2058689f845dfb10e59bd9ebeb5cb4e9318a9d` |

The other ten repositories get no `compat/1.0.0-rc.4` tag:

- **`vercel-ai`, `openai-agents-js` and `mastra`:** the release did not install `ai`, `@openai/agents` or
  `@mastra/core`.
- **The seven Python repositories:** no tested version is pinned for them.

## Adding a framework

When a new framework joins the epic, take these steps in one PR:

1. Fork it into `airprompter`, or mirror it privately if its licence forbids redistribution. Turn off Actions,
   issues, the wiki and projects, and point the description at upstream.
2. Add the repository to `forks.json`, with `packages`, the upstream's tag pattern and `testedVersionFrom`.
3. Add the repository to `FORK_SYNC_TOKEN`'s repository list.
4. Extend the count in `scripts/forks/lib.test.mjs`.
