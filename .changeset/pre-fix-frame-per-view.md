---
"@nannier-com/lookout": patch
---

A pre-fix frame is frozen once per VIEW rather than once per issue, so a view an
issue only gains later gets a picture of its own defect too.

An issue grows when the same root cause turns up on another route, form factor
or scheme. The first freeze wrote every view it could see and then declared the
issue done, so a member that joined afterwards had no frame, and since the card
draws the frozen pair rather than the live store, that view simply did not
appear on it. Each view is now frozen at the save that files the finding on it,
and a view already frozen is never re-copied, so the original defect is still
what the pair compares against.
