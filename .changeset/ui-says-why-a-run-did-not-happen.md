---
"@nannier-com/lookout": patch
---

The UI now tells you why a run did not happen, instead of going quiet.

Clicking Play, picking a folder and getting nothing back was three separate
defects, each turning an explanation lookout already had into silence.

**The message was erased before it could be read.** Every failure path wrote its
reason into the `where` element, and the polling loop overwrote that same element
with the project path on its next tick. One element, two writers, and the path
always won, so "no .lookout/config.ts in ..." appeared for a fraction of a second
and vanished. Notices are now held as state and rendered in preference to the
path, with their own styling: the path is clipped to one right-to-left line
because a path is read from its tail, while a message wraps and reads normally.

**A run that died said nothing.** The check was spawned with its output discarded
and only an `error` handler attached, which fires when a process cannot be
launched and never when it exits non-zero. A run that started and died a second
later left the page idle and blank. Its stderr is now kept and an `exit` handler
records a non-zero code, surfaced through `/api/status` and shown on the page.
Exit 1 is not treated as a failure: that is findings, which is an answer.

**Nothing checked the target first.** The UI spawned a run before asking whether
the app was reachable. It now probes with `preflight` and refuses with a reason
naming the target, its status and its `startHint`, rather than starting a run
that dies on `requireUp` moments later with its output thrown away. The wording
is shared with the CLI through a new exported `downReason`, so both say the same
thing about the same state.
