---
"@nannier-com/lookout": minor
---

A fix that causes a different defect no longer regresses the issue it fixed.

New user-visible behaviour, which is what makes this a minor: `verify-fix` now
rules on one question, is this issue's defect gone, and files anything else it
finds as its own numbered issue. The new issue carries `causedBy`: which issue's
fix was in flight, at which commit, in which run. The issue that surfaced it
gets a line of history saying so, and nothing else.

What this replaces was actively wrong. A new critical or high finding on changed
pixels came back as the verdict `regressed` for the issue being verified, even
when its own findings were completely gone. Its findings stayed open, every
member's `fixAttempts` incremented, and since the default cap is two attempts, a
second occurrence blocked the issue and wrote a mandatory reason asserting "the
defect persists" about a defect that had been fixed two rounds earlier.

`regressed` is gone from the verdict union and from the board's statuses. A
finding with the same fingerprint reappearing after being marked fixed still
reopens, as it always did: that is the same defect coming back, which is a
different thing from a fix causing a new one.

Exit codes are unchanged, so a pass is still 0 even when the run filed new
issues. They are named in the ruling and carried as `spawned` under `--json`;
they are separate work, and dispatching them is a separate decision.
