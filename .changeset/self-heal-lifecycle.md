---
"@nannier-com/lookout": patch
---

self-heal gets a lifecycle. lookout now picks the one group a run works on
(highest 30-day pressure among active groups; the model no longer chooses
from a menu of twelve), committed heals are marked in `~/.lookout/
heals.jsonl` so a settled group stops being offered while one that recurs
comes back loudest, groups with two reverted attempts wait for a person,
and the log compacts entries older than 90 days once it outgrows 2000
lines (reads were capped at the last 200 lines while sorting by count, so
old floods dominated invisibly). An unparseable healer reply now forfeits
its edits: reverted, kept for a person with the raw reply, recorded as an
incident, exit 1; it previously became a commit whose subject was raw
model prose. The frozen-set replay gate stops being opt-in: without
`--project`, lookout replays up to two recent projects that hold a usable
set, and when none exists the commit and changeset say the judge itself
went unreplayed; `lookout protocol` now matches. `.changeset/` is created
before writing into it.
