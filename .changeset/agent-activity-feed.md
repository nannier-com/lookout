---
"@nannier-com/lookout": minor
---

Show what each fix session is actually doing, line by line, while it does it.

The capability, and the reason this is a minor: every board entry now carries a
`timeline`, the cluster's running account of itself, oldest first. Dispatch, the
session picking it up, every progress note that session reported, its hand-back
with the commit, lookout re-judging, and the verdict. It is on `lookout status
--json` and `lookout agent list --json`, and `lookout ui` renders it as a live
feed on every card, tailing the newest line while a session is still working.

A status word says where a session got to. This says what it has been doing,
which is the question somebody watching a dozen sessions actually has. The
briefs now ask for it: a fix session is told to narrate each meaningful step
with `lookout agent note`, in one short concrete line, after it has looked at
the screenshots, when it knows the root cause, before a substantial edit, and
when it commits. Those lines claim nothing and close nothing; `verify-fix` is
still the only thing that rules.

Three bugs fixed along the way, all of which made the page look unstable.

`lookout agent` modelled a report as a run. Reporting is instantaneous and has
no end to emit, so the log was left claiming a run was in flight forever, and
the header showed "agent note app--render-failure--..." where the phase goes.
Reports now attach to the board rather than opening a run of their own.

A run that was killed never emits `run-end`, so the log said running forever:
`lookout ui` showed a pulsing live dot and a clock climbing past five hours over
an empty board, and `lookout status` reported RUNNING for a process that died
hours earlier. lookout cannot see a process die, so silence is the only evidence
available: past ten minutes with nothing said, both now say stalled and how long
it has been quiet. The fold exposes `lastEventAt` and stays pure; the threshold
lives with the callers.

The page rebuilt its stat row on every 1.5-second poll, because that one section
was assigned directly instead of going through the repaint guard every other
section used.

Two sections are gone. The activity log is redundant now that each card carries
its own feed, and the grid of captures no cluster was filed against answered a
question this page does not ask; the run's contact sheet is one image with every
capture on it, and is now a single link in the header instead.
