---
"@nannier-com/lookout": patch
---

A run says which judge is working, and writes down what it says.

Judging emitted one line when it started and the next when a whole view group
was done. A view group is five panel calls of about a minute each, so that was
five to eight minutes in which a working run said nothing at all, which on a
page reads exactly like a run that has died. It also called those five calls
"1 batch", which is true of the report and misleading about the clock. Both
counts are now quoted, and each panel narrates as it begins: `judge-geometry on
app/dashboard (2/5)`.

Underneath that, what the judges actually say is written to `narration.jsonl`
in the capture workspace, beside the event log rather than in it: the event log
is the durable record a board is rebuilt from and is re-read in full on every
push, while narration is a tail nothing is reconstructed from and is written a
hundred times more often. It is capped, discarded per run, and only produced
when something is listening, so a run judged from a terminal with no page open
costs nothing extra.
