---
"@nannier-com/lookout": patch
---

The settings cog moved to the foot of the left rail, and its panel moved with it.

The cog sat in the header beside the run button, where the two controls that
have least to do with each other were adjacent: one starts a check, the other
configures where lookout is pointed, and the press that costs money was a
neighbour of the press that costs nothing. The rail already holds the page's
navigation and had an empty half below its two areas.

The cog is now the last thing in the rail, pushed to its foot. It is not a third
area: it carries aria-expanded rather than the aria-current the two area buttons
carry, and no data-view, so nothing routes to it and the area you were in is the
area you are still in when the panel opens over it. It is round where they are
rounded squares, and it never wears the accent that marks the current area.

The panel follows the button. It used to drop out of the header as a full-width
row, which pushed the whole board down every time somebody opened it; it is now
anchored beside the rail at the cog's own height, floating over the board
instead of displacing it, capped to the viewport and scrolling inside itself
when there is not room. It carries a heading, because a panel that no longer
sits under the word it opened from has to say what it is. Escape still closes
it, the cog still says "Close settings" while it is open, and the destructive
prompt still stands in front of it.

The narrow header is 28px shorter as a result: the cog was the element that
pushed the run controls onto a line of their own.
