---
"@nannier-com/lookout": minor
---

Minor justification (new public capability): the page's tool picker is a
selector rather than a switch, and two tools selected work one issue together.

Pressing the second mark used to replace the first, because an issue went to one
tool and the choice was one name. Selecting both now means both: the queue
records the list, hands the issue to the first, and gives the turn after a spent
attempt to the next one on the list instead of back to the same tool. The second
agent opens on a tree the first has already worked, and on a note it left in the
issue's own folder saying what it changed and why, so the review has the "why"
that a diff never carries.

Turns rather than a committee, because they share one working tree: two agents
in one checkout is the failure the queue's lease exists to prevent, and nothing
about selecting two tools relaxes it. One tool selected behaves exactly as it
always did, down to the same tool getting its own issue back.

A queue written by an older build names one `tool`, and is read as a one tool
list rather than migrated, so an upgrade loses no press and a downgrade strands
nothing.
