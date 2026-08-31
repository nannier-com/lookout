---
"@nannier-com/lookout": patch
---

The page's script is now nine modules instead of one. `board` renders a card,
`filters` owns the headline numbers, `tools` owns which editor an issue opens
in, `settings` owns the panel, `shell` owns the frame and the rail, `state`
holds what the page knows between polls, and `main` is the poll, the clicks and
the boot order. Two people working on the card and on the settings panel no
longer edit the same file.

The dependency graph is acyclic, which took one deliberate inversion: several
actions have to redraw the page when they finish, but the poll that redraws it
needs every renderer, so the loop registers itself as the refresher at startup
rather than being imported by the modules that trigger it.

Fixes a bug this work surfaced: the "Showing only ..." bar had no `[hidden]`
rule, so an author `display:flex` beat the browser's own hiding. Clearing a
filter left the bar on screen over a board showing everything, and its margin
took fourteen pixels off every page load. The two neighbouring rules had the
same guard already; this one was missing it.
