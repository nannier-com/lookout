---
"@nannier-com/lookout": patch
---

`lookout check` was one 320-line function that captured, partitioned the cache,
judged, verified and reported. Its own comments numbered those steps 1 to 6,
which is where it has now been cut: `check/scope` (what this run is looking at),
`check/plan` (what still needs judging, by which rules, and what is already
open), `check/batches` (the judging and the refuter behind it), and
`check/outcome` (the ledger and the report). The verb is the order they run in.

No test called `runCheck`, so the split was verified by running the verb against
a real page: a full capture and judge, a second run served entirely from the
ledger cache, and the empty-scope guard.
