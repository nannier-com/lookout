---
"@nannier-com/lookout": patch
---

Stale placements are recognised and re-derived. The stored record always
carried the kit name "so a stale placement is recognisable", and nothing
recognised it: a kit rename, an editability flip, or the placed file
vanishing now re-derives the placement on the next check, stale ones
outranking fresh unplaced issues for the cap (wrong advice beats no advice
to the fix). The path is verified to exist the moment a placement is
written (a reply naming a ghost file keeps the advice, drops the path, and
says so), and an issue document whose placed file has since vanished
annotates the path instead of pointing a fixer at nothing.
