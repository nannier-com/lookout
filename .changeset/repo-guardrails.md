---
"@nannier-com/lookout": patch
---

Two guardrails, so the restructuring holds.

A `max-lines` ceiling of 300 code lines per source file, with comments and blank
lines not counted: the prose in this codebase is the point, and a rule that
punished it would be a rule against explaining things. The seven files that
predate the ceiling are pinned in `eslint.config.mjs` at the size they were, so
each may be split and none may grow.

A repo `CLAUDE.md` saying where a change goes, what the tooling enforces, how to
verify the two kinds of change that green gates do not cover (anything the page
renders, and any verb, since the suite covers modules rather than compositions),
and how to work in a checkout several sessions share.
