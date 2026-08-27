---
"@nannier-com/lookout": patch
---

`lookout backlog check` no longer reports every open AI finding as resolved by
drift.

The gate the fix loop ends on flags an open finding whose screenshot was
re-captured in the newest run but which no merge refreshed, on the reasoning
that it was probably fixed and nobody adjudicated it. It compared each finding's
`lastSeen` against the newest capture run, but the merge stamped the two
channels from different id families: deterministic findings got the capture run
id (`web-…`) and AI findings got the judge's own (`check-…`). Those never match,
so every open AI finding the judge had re-found seconds earlier came back as
`open finding not re-found in run web-…; mark fixed or investigate`, the gate
exited 1 on healthy backlogs, and the real signal (a finding the judge silently
dropped) was indistinguishable from the noise.

Both channels are now stamped with the capture run id, so `lastSeen` answers the
question the check actually asks: which capture run did this finding survive?
The judge run id is not lost. It stays on the check outcome and in
`judge-report.json`, and every evidence ref already carries the run its
screenshot came from.

Existing backlogs correct themselves on the next `lookout check`, which restamps
each finding it re-files. A finding that is genuinely gone still reports as
drift-resolved, which is the point of the check.
