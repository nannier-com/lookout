---
"@nannier-com/lookout": patch
---

**The capture workspace lives inside the project it belongs to.** Screenshots
and their provenance sidecars, `capture-report.json`, `judge-report.json`,
`verify-report.json`, `events.jsonl`, the narration, the judge transcripts and
the contact sheets are written to `<project>/.lookout/workspace/` now, beside
the backlog and the issue folders they were always paired with, instead of to
`~/.lookout/evidence/<project>-<hash>/`. `lookout protocol` names the new path,
so an agent reading the contract is told where the evidence is. The directory is
`workspace/` rather than `evidence/` because `.lookout/evidence/` is the
pre-0.35 store that `backlog` and the issue frames still adopt from, and one
name for both would make a live report indistinguishable from an inherited one.

**lookout writes the ignore line whenever it writes a config**, creating a
`.gitignore` when the project has none. Printing a note was fair while the
ignored directory held text; it is not now that a capture puts megabytes of
screenshots in the working tree. `lookout init` and the config a first run
writes from `--url` both go through it.

**The judge runs from a scratch directory outside every project.** Its working
directory used to be the evidence, which was outside every repository, so the
isolation came for free: the Claude Code CLI reads instructions upward from
where it stands, and standing in the operator's home meant a judged project's
`CLAUDE.md`, its `.claude/settings.json` and its hooks never reached the oracle.
With the workspace inside the project that had to be asked for, so
`invokeClaude` now defaults to a per-process scratch directory. Every path a
prompt names is absolute, so the judge loses nothing by standing somewhere
empty.

Nothing is migrated: one capture rebuilds the workspace, and the pixels worth
keeping were frozen into each issue's folder when it was filed. An old
`~/.lookout/evidence/` is no longer read and is safe to delete.
