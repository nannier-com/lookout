---
"@nannier-com/lookout": minor
---

**A new deterministic check: content painted over other content.** Every
geometry check lookout had asked about one element and its container. None
compared two elements with each other, so a chip drawn across the name beside
it, a floating control covering the last row of a table, or a bar sitting on
the heading under it, all of which destroy information outright, were visible
to nobody but a judge reading an image.

`box-collision` measures the overlaps from live boxes and files under
`layout-overflow` at medium, naming both elements by their own on-screen text
and how much of the covered one is hidden. Overlap on its own means nothing,
because a page is layers and most of them are deliberate, so the check counts
only two ordinary siblings in normal flow whose overlap the browser itself
confirms at the intersection centre. Anything positioned out of flow is
excluded, and so is everything inside it: the items in a dropdown are ordinary
static elements, and it is the panel around them that was lifted, so checking
the element alone found every menu item sitting on whatever the open menu
covers. Modals, hidden and transparent elements, and ancestor pairs are
excluded for the same reason. It shares the `--no-edge-clip` switch, since both
answer the same question about whether content is where a reader can read it.
