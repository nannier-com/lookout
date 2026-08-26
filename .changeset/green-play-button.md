---
"@nannier-com/lookout": patch
---

The Find and fix control is a green play button.

A round green button with a play triangle, rather than a rectangle with words
in it: the whole control means "go", so it reads faster as a shape. Its name
lives in `aria-label` and the tooltip, which also names the repository it will
check and says that the run stops at the first issue.

While a check is running the triangle gives way to a ring turning around it, so
the same control shows the run is live without moving or resizing. The green is
a token in both schemes, darker in light and brighter in dark, and distinct from
the green used for a finding that passed.
