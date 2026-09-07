---
"@nannier-com/lookout": patch
---

A click beside the settings panel dismisses it.

The panel floats over the board now rather than sitting in the header, so the
click people reach for to uncover what it is covering is a click beside it,
ahead of Escape and well ahead of a second trip to the cog at the foot of the
rail. There were two ways out and now there are three.

The click is spent on the dismissal and does nothing else. That matters here
because the board underneath carries the buttons that file an issue and reorder
the fix queue, and one press should not both put the panel away and move one of
those. It cancels a link's own default too: the shot tiles are anchors to the
raw PNG with target="_blank", so without that the press that put the panel away
also left a picture open in a new tab.

It is the first thing the page's click handler asks, so that every control
counts as outside. Placed below the handlers it shares that function with, it
read as the same rule but was not: a shot tile, a rail button and the tool
toggle each answered first and left the panel open over whatever they had just
changed. The one exception is the destructive prompt, which is the only thing
that opens on top of this panel: while it is up nothing behind it is outside
anything, so answering it still finds the panel where it was.

`tools/ui-check drive` covers all of it, nine assertions checked against a
build without the change to confirm each one fails there.
