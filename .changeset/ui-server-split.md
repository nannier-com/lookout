---
"@nannier-com/lookout": patch
---

`lookout ui` was one 1830-line file holding the HTTP server, the router, the
thumbnailer, the child process that runs a check, the board cache and the whole
front end. Any change that was UI-shaped at all had to open it, which made it
the file two sessions were most likely to collide in: 28 of the last 200 commits
touched it.

It is now the verb alone, with what answers each request beside it under
`src/ui`: `routes` (which handler serves what), `payload` (the board and the
self-improvement record, and their caches), `evidence` (screenshots and
thumbnails), `run` (the check the play button starts), `project` (where lookout
is pointed and whether its targets answer), `session` (the state one server
process carries), and `page`. `ui-settings` and `ui-learning` moved alongside as
`ui/stored-settings` and `ui/page-learning`.

Behaviour is unchanged: the served page renders pixel for pixel as before across
both areas, both colour schemes and a narrow viewport, the only difference being
a relative clock that had advanced.
