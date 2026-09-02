---
"@nannier-com/lookout": patch
---

**`self-heal` keeps its own record beside the checkout it edits.** The lock,
the heals that stuck and every reverted attempt's diff, gate output and raw
reply now live under `<lookout checkout>/.lookout/self-heal/` instead of under
`~/.lookout`. The lock guards a checkout, which is what it was always for: two
heals in one checkout revert each other's work and commit the result, and a
lock kept anywhere else was guarding the wrong thing. A heal is a commit in
that repository, so a settled group stays settled whichever project the next
run starts from.

`self-heal` now refuses to run in a checkout that does not ignore `.lookout/`,
naming the fix, because a failed gate reverts with `git clean -fd` and would
otherwise delete the attempt it had just written and the log it read to choose
the work. lookout's own repository has ignored it all along.

An installed package has no checkout, so it has no heals, no attempts and no
lock, and the learning area of `lookout ui` renders that state rather than
assuming a directory exists. `~/.lookout/heals.jsonl` and
`~/.lookout/self-heal/` are no longer read or written; only the ui's settings
still live in the home.
