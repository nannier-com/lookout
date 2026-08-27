---
"@nannier-com/lookout": minor
---

Every issue now has a six-digit number and a folder of its own.

New user-visible capability, which is what makes this a minor: `.lookout/issues/<id>/`
holds everything about one defect. Its record (`issue.json`), its document
(`ISSUE.md`), the screenshots it was filed against (`shots/`), what the last
re-check saw (`recheck/`), and every attempt made on it (`state.json`). Opening
that folder answers "what is this" without the tool, the backlog, or the
conversation that produced it.

The id is drawn at random from 100000 to 999999 and minted once, the first time
a root cause is seen. Clustering still decides what groups with what: that is
the derived key, and it still has to be recomputable so a defect re-found next
week merges instead of duplicating. The number is the name people use. The
registry lives in `backlog.json`, which is committed, because an id that cannot
be recomputed and is not written down is an id that comes back different and
orphans the folder named after it. Nothing is ever pruned or reused.

`verify-fix --cluster app--color-scheme--dark-mode` is now
`verify-fix --issue 418203`. The old flag is gone rather than aliased: it named
an identity that is now internal, and a dead alias for it would be one more
thing to explain. Everything else adjusts on its own, including backlogs written
before ids existed, which are repaired and rewritten the first time any verb
loads them. `lookout backlog check` fails on a root cause with no id.

`BACKLOG.md` gained an `issue` column, and its headline counts issues as well as
findings: the number is the thing people quote, so it belongs on the report
people read.

Attempt history moved with it: `.lookout/evidence/fix/<key>.state.json` is now
`.lookout/issues/<id>/state.json`, which means it survives an evidence clean.
Add `.lookout/issues/*/shots/` and `.lookout/issues/*/recheck/` to .gitignore;
the record beside them is worth committing, the pixels are not.
