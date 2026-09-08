---
"@nannier-com/lookout": patch
---

`stopWatching` now stops: it unsubscribes from the project change instead of
only closing the watchers.

A stopped watcher kept the subscriber `startWatching` had registered, so the
next `setCurrentProject` re-armed `fs.watch` on the new project and scheduled a
reaction that pumped that project's queue, dispatching a handoff nobody had
asked for. In one `lookout ui` process this only shows at shutdown; in the test
suite, which runs every file in one process, the subscriber left behind by one
file fired inside later files and failed a gate on roughly half its runs.

Starting twice now registers one subscriber rather than two, and a reaction
already in the air when the watcher is stopped returns before it dispatches.
