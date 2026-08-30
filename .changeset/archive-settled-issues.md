---
"@nannier-com/lookout": minor
---

Minor justification (new public capability): settled issues can be filed away.
A done issue's card offers to archive rather than to open in a coding tool,
which was the wrong thing to offer: there is nothing left to hand a fix session
about a defect lookout has already confirmed gone.

Archiving records why it happened and moves the issue's folder to
`.lookout/issues/archive/<id>/`. The record decides and the folder follows on
the next save, so the two cannot drift; readers that only have an id find the
folder wherever it is. A `fixed` archive is never described as one somebody
adjudicated intentional, which is the older meaning of the same status.

Two guards. Archiving refuses while any finding is open, because hiding live
work is the one thing an archive must not do. And an archived issue whose defect
comes back un-archives itself, folder and all, on the save that reopens it.
Archived cards carry a restore button; an archive with no undo is a trapdoor.
