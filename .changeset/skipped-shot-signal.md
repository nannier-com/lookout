---
"@nannier-com/lookout": patch
---

**A run says which judge left which screenshots unruled, not just how many.**
A panel whose reply accounts for a shot in neither its findings nor its clean
list costs that whole (view group, panel) pair its cached verdict, and the run
reported only a count of such shots. The count says a verdict is missing
without saying whose it was or about what, so nothing could be taught from it.

The judge report now carries `unaccounted`: the panel, the view group, and the
shot ids, beside the existing `unjudged` count. `skills improve` reads it as a
new signal kind, one per panel per run, since a reply that dropped four shots
dropped them under one set of instructions. Where the panel's own prose names
a shot it left out, that finding's title goes in the signal, because a defect
the panel described on a shot it never listed is exactly the failure the
output contract exists to catch.
