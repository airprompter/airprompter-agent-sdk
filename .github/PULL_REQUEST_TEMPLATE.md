<!-- Title: one plain sentence saying what changed. Body: why. See CONTRIBUTING.md. -->

## What and why

## Checklist

- [ ] Commits are signed off (`git commit -s`, the DCO)
- [ ] Tests added or updated for every part touched; `npm test` / `pytest` green locally
- [ ] Both SDKs changed together for a behaviour change (or the PR says which half is missing)
- [ ] `protocol/` change: `conformance/` updated, `protocol/CHANGELOG.md` line, `protocol/VERSION` bumped if the wire changed
- [ ] Public API change: a line under **Unreleased** in `CHANGELOG.md`; `npm run compat-table` if a version moved
- [ ] No key, token, prompt text or end-user identifier in code, fixtures or logs
