---
"@nannier-com/lookout": patch
---

`lookout skills` follows the rule the repo now states: a verb dispatches, it
does not hold the work. `skills/history` is lookout's record of what it did to
its own instructions and the lock it holds while doing it, `skills/replay` is
the gate that judges the frozen set through the real pipeline, refuter included,
and `skills/amend` is the only part that writes.

The verb keeps its five subcommands and re-exports the names other modules have
always imported from it, so nothing else changed.
