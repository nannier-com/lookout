---
"@nannier-com/lookout": patch
---

`verify-fix` refuses `--no-capture` (a ruling on the last capture instead of
a fresh one) and `--axe off` (every accessibility criterion met without the
check running), before anything runs, with the reason in the error. Both
passed through to the re-capture and could confirm a fix nothing had looked
at. A `--settle` that differs from the one the filing capture used is noted
in the run log rather than refused, since a slow render sometimes needs it:
pixels may move for reasons unrelated to the fix.
