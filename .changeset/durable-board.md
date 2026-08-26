---
"@nannier-com/lookout": minor
---

The board survives a restart, because outstanding work is state, not narration.

The board was a fold over `events.jsonl` alone. That file is narration, and
every `check` or `capture` run truncates it. So the moment anything re-captured,
or the machine was restarted, a project with thirty-seven open findings and
eighteen briefs written showed "nothing dispatched yet", and every record of who
had worked what went with it. Real numbers from a real project: the board read
zero while the backlog held 37 open and 16 blocked findings.

The durable answer was always sitting next to it. `backlog.json` is the
adjudicated record of every finding, clustering is deterministic, and each
cluster's attempts and fix sessions live in `fix/<id>.state.json`. So the board
is now built from those, and the event log is demoted to what it actually is: an
overlay saying what is happening this second on top of a board that exists
whether or not a run is in flight. `lookout ui`, `lookout status` and `lookout
agent list` all read the same rebuilt board.

The consequences, all of which were broken before:

Blocked work stays on the board instead of vanishing, because a cluster that
exhausted its attempts is exactly what somebody looking at this needs to see.

A fix session's history outlives the run that recorded it. Its notes, its
commit, and lookout's ruling are reconstructed from the state file, so a card
still says who fixed what and what the judge said days later.

Disk is authoritative for what the work is; the log only adds what disk cannot
know. A re-judge in flight is read from the events directly rather than from the
fold, because a log truncated by a plain `check` carries no dispatches for the
fold to attach to. A dispatch event can no longer resurrect work the backlog has
settled.

Two smaller fixes fell out. A cluster is dated by the earliest thing recorded
about it rather than by its brief's mtime, since `verify-fix` rewrites the brief
when it hands a cluster back, which pushed the dispatch to after the session
that had already worked it. And work that has never been sent to anybody now
says "not dispatched yet" instead of dating itself to 1970 and rendering
"dispatched 496604h06m".

The page holds its rebuilt board until `backlog.json`, the event log or the fix
directory actually changes on disk, so polling twice a second does not re-read a
hundred kilobytes each time.
