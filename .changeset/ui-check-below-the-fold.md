---
"@nannier-com/lookout": patch
---

The visual gate captures the half of a card that is below the fold.

`shots` took every view with a full-page screenshot, and on this page that is
the viewport and nothing else: the page sets `body { overflow: hidden }` and
scrolls the board inside its own container, while a card runs to about 1400px.
Everything past roughly a card's midpoint was in no capture at all. The comment
on the `board-done` view claimed it was the one shot carrying both halves of a
pre and post fix pair; it carried the top of that card, and the pair section
began 60px below the frame.

Measured against the commit that rewrote that section from a horizontal strip
into two columns: the full-page capture reports the two revisions identical at
both 1440x950 and 430x900, and a capture clipped to the card reports 45% and
32% of its pixels changed. The acceptance list, the record timeline and the
paths were unreached the same way, the timeline and the paths in every single
view.

`shots` now also takes four `section` captures, which scroll a card's divider
into the board's scroll container and clip to the card: the settled issue's
pair section, which is the only one with both halves, and the still-open one's,
which pairs a single frame with the alert standing in for the frame that does
not exist yet, each at the default size and at a narrow viewport where two
columns are what breaks. The open card's clip runs on past its shorter pair
section to take in the record timeline.

A section capture names the card by what it holds rather than by where it sits,
so it fails loudly when that markup goes instead of quietly framing a different
card, and its height is fixed rather than measured from the section, so a
layout change reports as pixels inside a stable frame with a crop rather than
collapsing into `diff`'s size alarm. Each height stops above the "On disk"
paths, which are absolute and would make a view differ between checkouts rather
than between revisions, and the capture checks that it did rather than trusting
the number.
