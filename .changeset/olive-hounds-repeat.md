---
"@nannier-com/lookout": patch
---

**Incidents are recorded where they happened.** What goes wrong with lookout
itself, crashes, operator errors, judge replies that could not be parsed and
findings rejected at ingestion, is appended to
`<project>/.lookout/incidents.jsonl` instead of to one file per machine. A
failure with no configured project in scope goes to lookout's own checkout,
and on an installed package, which has no source to heal and no `self-heal` to
read the log, it is dropped rather than written into whatever directory the
command was run in.

`lookout check` and the learning area of `lookout ui` now report the failures
of the project in front of them. `lookout doctor` reads both the project it was
run in and lookout's own checkout, and prints which logs it read, so "none
active" cannot be mistaken for "nothing has ever gone wrong". `lookout
self-heal` reads its own checkout, the project it was started in, and the one
`--project` names; what that gives up, and it is a real loss, is clustering
across projects, so a bug seen once in each of three projects no longer adds up
to one heavy group.

An incident's `project` is a directory at every write site now. Ten of them
recorded the display name from the config, which made the field useless for
finding a project that could grade a replay; the judge, the refuter and the
reply ingest are handed the project's directory to make that true.

`~/.lookout/incidents.jsonl` is no longer read or written. Nothing is migrated:
old entries name projects by display name as often as by path, and the log ages
out its own entries after 90 days.
