---
"@nannier-com/lookout": patch
---

The shot inspector can be dismissed by clicking beside the picture, and its
close control says "Close".

Opening a screenshot from the board left people stuck in the overlay: the only
ways out were the Escape key and a bare multiplication sign in the corner of a
bar that, in the dark scheme, is nearly the same colour as the scrim behind it.
Clicking the darkened area around the picture, which is what anyone tries first,
did nothing at all.

Three changes, all in the overlay:

- A click that lands on the scrim rather than on the picture, a box or a control
  closes the inspector.
- The close button is labelled, filled and carries its shortcut in a tooltip,
  instead of being a lone glyph on a near-black bar.
- The element-provenance layer no longer swallows clicks that fall between its
  boxes, so a click on the picture reaches the picture.

The interaction gate had covered Escape only, which is how an overlay nobody
could click their way out of shipped; it now drives all three exits and asserts
that clicking the picture itself does not close it.
