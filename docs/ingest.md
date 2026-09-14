# Ingest: your prompts become approved versions

Two of the three ways teams keep prompts today — a directory in git, a
table in Postgres — have nothing for the sync library to pull until those
prompts exist as **approved versions** in AirPrompter. `airprompter import`
is the round trip: the prompts you already have become workspace prompts
with reviewable versions, your reviewers approve them on the board, and
from there they are set up on an agent and released like any other.

The rules, each pinned by a test on both sides:

- **The prompt id is derived** from the workspace, the import key and the
  item key — never matched by title or content. The import key names your
  *source* (`git:prompts`, `postgres:prompts`); the item key is your
  system's own identity for the prompt (a relative path, a slug, a row id).
  Use the same keys on every run and a re-run finds exactly what it made.
- **Unchanged content writes nothing.** The route compares against the
  prompt's current draft; an unchanged item answers with the version it
  already has.
- **Changed content is a new draft and a new version**, submitted for
  review — the same rule every version follows (a version is created
  submitted). The board shows it; nothing is released by an import.
- **A new key is a new prompt**, placed in the collection you named.
- **`--dry-run` prints the plan** — `create` / `update` / `unchanged` per
  item — and writes nothing.
- **Items fail one at a time.** A failing item is reported with a reason
  code and the others land; the exit status is `4` (partial) and the
  output names each item. Re-running retries only what failed.
- **A signed-in person, never an API key.** Team writes need a member's
  own session (the AIR-1854 rule: organization and workspace keys are
  read-only). `airprompter login` signs in with the member's email and
  password — the password from the environment or a terminal prompt,
  never argv — and prints a session token that lasts about an hour. The
  import reads it from `AIRPROMPTER_SESSION_TOKEN`.

Nothing printed by either command is prompt text. The plan and the result
name keys, ids, versions and reasons.

## Habit 1 — prompts in git

A directory of files, one prompt each; `.md`, `.txt` and `.prompt` count,
dotfiles and anything else are skipped, sub-directories are walked. The
item key is the path relative to the directory, so moving a file is a new
prompt and renaming it is too — keep paths stable, as you would for any
id. The title is the first `# heading` or the file name. An optional
front-matter block fills the rest:

```markdown
---
description: Triage an inbound support ticket
categories: support, ops
platforms: claude
tags: tier-1
---
# Ticket triage

Triage {{ticket}} for {{team}} …
```

`categories` and `platforms` (the AI services the prompt is for) are
required on every item — by front matter, or by a default on the command
line for the files that name none:

```bash
export AIRPROMPTER_PASSWORD=…            # or let `login` prompt on the terminal
eval "$(airprompter login --email you@example.com)"
airprompter import --workspace ws_… --collection col_… --from ./prompts --key git:prompts \
  --category support --platform claude --dry-run
airprompter import --workspace ws_… --collection col_… --from ./prompts --key git:prompts \
  --category support --platform claude
```

In CI, run the same command on every merge to `main`: unchanged files
cost nothing, edited files become new versions for review, new files
become new prompts. The workspace id and the collection id are in the
URL of the workspace's board and collection pages.

## Habit 2 — prompts in Postgres (or any database)

Export the rows as JSON and map the columns. The row's primary key or slug
is the item key:

```bash
psql "$DATABASE_URL" --json -c "select slug, name, body, category from prompts where active" > rows.json
airprompter import --workspace ws_… --collection col_… --from rows.json --key postgres:prompts \
  --map key=slug,title=name,content=body,categories=category --platform claude
```

`--map` names `key`, `title` and `content` (required) and any of
`description`, `categories`, `platforms`, `tags`; list columns are
comma-separated strings or JSON arrays. A row whose key or content column is
empty refuses the whole run before anything is sent, with the row number.
Schedule the export and the import together; the derived id keeps every
run on the same prompts.

## Habit 3 — an export from another tool

A CSV with a header row naming `key`, `title`, `content` and any of the
optional columns (quoted fields and embedded newlines are fine), or a JSON
file already in the route's shape (an array of items, or `{ "items": [...] }`):

```bash
airprompter import --workspace ws_… --collection col_… --from export.csv --key acme-tool:export \
  --category marketing --platform chatgpt
```

## After the import: approve, set up, release

Each created or updated version is on the workspace **board** as
*submitted for review*. A reviewer approves it there; an approved version
can be set up on an agent (a slot in the agent's release) and released
to an environment — `dev`, `staging`, `prod` — exactly as a version
authored in the app. From then on the sync library, the daemon and the
hosted route serve it under the same trust chain as everything else; the
import touched no release and moved no pointer.

## The route

`POST /team/workspaces/{workspaceId}/imports` with a member's session:

```json
{
  "importKey": "git:prompts",
  "collectionId": "col_…",
  "defaults": { "categories": ["support"], "platforms": ["claude"] },
  "dryRun": false,
  "items": [{ "key": "support/triage.md", "title": "Ticket triage", "content": "…", "tags": ["tier-1"] }]
}
```

The answer carries one entry per item — `key`, `promptId`, `status`
(`created` / `updated` / `unchanged` / `failed`; on a dry run `create` /
`update` / `unchanged`), `versionId`, `reviewSubmitted`, `reason` — and a
summary. Up to 200 items per request; run the command more than once for
more, with the same key. A request whose items repeat a key, or lack
categories or services with no default, is refused whole (`400`); an
unknown workspace or collection is `404`; a member without write
permission on the workspace is `403`.
