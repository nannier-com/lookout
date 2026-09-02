---
"@nannier-com/lookout": patch
---

**What `verify-fix` prints after a ruling carries the same facts the
regenerated document does.** The account now says how many attempts are left
before the issue blocks, what was photographed (URL, routes, form factors,
schemes) and what it was compared against (the previous capture's run and
when it finished, and how many comparable screenshots changed), which routes
had pixels that never moved, every finding still filed with the judge's own
account of it, each criterion with its verdict mark, its note, the shots that
decided it and the verifier's suggestion, what was recorded about the
repository (the commit, the uncommitted files, the files changed since the
previous attempt) beside the note verbatim, and that the document now carries
this attempt, with its path. A blocked ruling names the command that reopens
the issue. A ruling that could not be made says no attempt was spent. The
`--json` payload carries the same facts as objects: `attemptsLeft`,
`stillOpen` with shot ids and the judge's account, `baseline`, `photographed`,
`reported`, `observed`, `doc`, and `evidence` and `suggestion` on each
criterion.
