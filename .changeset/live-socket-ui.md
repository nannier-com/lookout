---
"@nannier-com/lookout": patch
---

`lookout ui` is pushed to over a socket rather than polled.

The page asked `/api/status` every 1.5 seconds, which suited neither side of
what it watches: a `check` says nothing for a minute and then files a finding,
so the poll was too slow to feel live and too frequent to be idle. The server
now holds a socket open per page and writes to it when the run log or the
backlog actually moves, which means a finding reaches the board in about a
tenth of a second and a board nobody is running anything against costs no
traffic at all. A run started in any terminal reaches the page, not just one
the play button spawned, because what is watched is the disk rather than the
child process.

Serving moved from node's http server onto bun's, which is what lets one route
upgrade instead of answer. Every route keeps its URL, its method and its body.
