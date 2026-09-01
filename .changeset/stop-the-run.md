---
"@nannier-com/lookout": minor
---

**Play stops the run it started, and the judge underneath it.** New capability
on the page: while a check is in flight, the play button is a stop button, and
pressing it ends the run and everything the run started, the Claude CLI
included.

There was no stop before, and no way to build one from what the server had. A
run was spawned into this server's own process group, so the only thing that
could be signalled was the check process itself, and a check is not one
process: it spawns `claude -p` per batch, and that grandchild is where the
minutes and the model spend actually go. Measured on 2026-09-01, a parent
killed with SIGTERM left its child running to completion. Anyone wanting a run
to stop had to find the process tree themselves.

A run is now spawned into a process group of its own, and `POST /api/stop`
signals the group: the check, the judge it is waiting on, and anything either
of them started. SIGTERM first, and that is not politeness, since playwright's
own handler is what closes the chromium the run is driving, with SIGKILL four
seconds later for a group that is stuck rather than closing. The one cost of
the new process group is that Ctrl-C on `lookout ui` no longer reaches the
run, so the verb now stops the run itself on the way out rather than orphaning
it.

A killed process cannot write its own `run-end`, so the log used to go on
claiming the run was live and the page animated a clock for it until ten
minutes of silence made it "stalled". Stopping now writes that line for it, and
the fold reports the phase as `stopped` rather than `done`, because the run did
not finish, it was ended.

On the page the triangle becomes a square inside the ring that was already
turning, so the control shows what it is as well as what it is waiting on, and
it dims between the press and the last browser closing rather than pretending
the click did nothing.
