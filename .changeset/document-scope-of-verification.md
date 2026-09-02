---
"@nannier-com/lookout": patch
---

**The issue document says what lookout will photograph before anyone asks
for a ruling.** A "Scope of verification" section names the target and its
URL, every route `verify-fix` will re-capture and which of them the shell
rule added from the config (a shell defect is ruled on at least two routes),
the form factors and schemes, the panel that re-judges, and the fact that
lookout rules on what the URL serves at that moment and never starts, rebuilds
or restarts anything (with the config's `startHint` when it has one). It
states the pixels-moved rule and what the comparison is against, naming the
run that filed the issue and when it finished, and that a `lookout capture` or
`check` of those routes between the edit and the ruling replaces that baseline
so a real fix reads as no change. When the capture workspace still holds the
filing run, the flags it ran with are listed. Every `verify-fix` flag is named
with what it does to the ruling: which are set from the issue, which narrow
the capture and the comparison, and which cannot confirm a fix.

The verify block says `--commit` may be left out, what `--note` becomes and
what the useful ones have said, that a ruling which does not pass spends an
attempt (N of M spent), what blocks the issue, that `--max-attempts` raises the
cap for one ruling, and what every exit code means, including 2: lookout could
not rule and no attempt was spent. The routes a target's config lists are
derived once (`configuredRoutesOf`, beside `clusterScope`) for the verb and the
document alike, so the two cannot disagree.
