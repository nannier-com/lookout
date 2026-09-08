---
"@nannier-com/lookout": minor
---

Warn when a target is serving a build older than the source, and stamp the run that
photographed it.

A verdict is only as good as the pixels it was made from. A server holding a stale build
renders a page that is complete, valid, and not the code that was written, so the run
comes back clean and wrong, which is worse than a missed finding because nothing in the
report says to look again. lookout already said exactly this about its own build in
`warnIfStale()`; the reasoning had never reached the app being photographed.

Every capturing verb now compares what a target volunteers about the age of what it served
against the newest source file on disk, and prints the gap before the browser launches.
The run records it too, in its flags, so an issue filed from a suspect run carries that
doubt with it. Nothing is refused and nothing is rebuilt: lookout never starts services,
so it reports and leaves the run to the operator.

No configuration. A server that sends no `Last-Modified` is silent, which is the
hot-reload case where the page is compiled per request and already fresh, and where the
source walk is skipped entirely.
