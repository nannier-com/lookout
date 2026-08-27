---
"@nannier-com/lookout": patch
---

Issue folders now hold `Issue.json`, `Issue.md` and `img/` (previously
`issue.json`, `ISSUE.md` and `shots/`). The folder root is unchanged:
everything about one issue still lives in `.lookout/issues/<id>/`, and ids
stay exactly six digits. `state.json` and `handoff.command` keep their names.

Folders migrate themselves on the next backlog save: legacy names are removed
before the new ones are written (the renames are case-only, so removing them
afterwards would delete the fresh files on a case-insensitive filesystem),
and the pixels in `shots/` are moved into `img/` rather than deleted, so they
survive even when the evidence store they came from has been cleaned.

The never-populated `recheck/` folder is gone from the protocol, the README
and the UI: no code ever wrote it, and the UI strip that displayed it could
never show anything.

For consuming repos:

- In `.gitignore`, change `.lookout/issues/*/shots/` to
  `.lookout/issues/*/img/` and delete the `.lookout/issues/*/recheck/` line.
  Leave `.lookout/regression/shots/` as it is; the regression store is
  unchanged.
- A repo that committed issue folders will see every record regenerate under
  the new names. The case-only renames are invisible to git while
  `core.ignorecase` is on, so run
  `git rm -r --cached .lookout/issues && git add .lookout/issues` once to
  record them.
