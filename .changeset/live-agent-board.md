---
"@nannier-com/lookout": minor
---

Show which fix session is working which cluster, live, with that cluster's own
screenshots.

New capability, and the reason this is a minor: a `lookout agent` verb. lookout
dispatches work into child sessions it cannot see, so between a dispatch and the
verdict that closes it, it had no idea whether a cluster was untouched or had
had an agent on it for twenty minutes. Both rendered as the same words,
"awaiting a fix session". The orchestrating run now says so: `lookout agent
start --cluster <id> --name "<label>"` when it spawns a session, `agent note`
as a heartbeat, and `agent done --cluster <id> --commit <sha>` when it replies.
`agent list` prints the board. None of it adjudicates anything; a session saying
it is done is still only a claim, and `verify-fix` remains the only thing that
closes a finding. Reporting is optional by construction, and a harness that
never calls it leaves its cards at `queued`, which is exactly what lookout knew
before.

Two bugs behind that, both structural. The event log truncated on every run, and
`verify-fix` opened it the same way `check` does, so ruling on one cluster
erased the dispatches of every other cluster and every session working them: the
board could not accumulate at all. Runs that report against a board now join it
instead of starting one, and the log is pruned rather than wiped once it grows.
And a dispatch carried only a count of its screenshots, never their paths, even
though the cluster's contact sheet had just been composited and thrown away. It
now carries both, so a card can show the evidence its own session is looking at.

`lookout ui` is rebuilt around that. It was a page-level report: one flat list of
identical dispatch rows, and below it a single undifferentiated grid of every
capture in the run, which answered "what did lookout see" but never "who is
working on what". It is now a board of fix sessions. Each card carries its
status, who is on it and for how long on a ticking clock, its severity, routes
and attempt, the screenshots the defect was filed against, its contact sheet,
and, once a fix is claimed, what `verify-fix` saw afterwards. Captures no
cluster was filed against are collapsed out of the way. `lookout status` gained
the same board, so an agent polling it sees what a person watching sees.
