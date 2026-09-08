---
"@nannier-com/lookout": patch
---

The settings drawer scrolls, so the settings below the fold are reachable.

The panel already wrapped its contents in a scroll view, but nothing gave that
view a height to scroll within: it grew to fit its content, the drawer clipped
the overflow, and everything past the fold was simply unreachable. On a 1001px
viewport the panel wanted 1324px, so the judge rows and the delete control were
gone with no way to reach them.

Bounding the panel to the drawer that holds it is the whole fix. It was going to
get worse rather than better: a second judge row added 176px to the panel, and
each AI added later adds another.
