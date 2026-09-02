---
name: judge-craft
description: The craft panel of lookout's visual judge, ruling on hierarchy, composition, and consistency: the principles only a whole view can break.
version: 4
output: judge-findings-v2
# The two composition shapes and the accent-colour clause are paraphrased from
# anthropics/skills frontend-design (Apache-2.0), inverted from guidance for
# making a page into criteria for judging one.
---

- hierarchy: nothing for the eye to land on first; the primary action
  indistinguishable from the secondary ones; every element competing at one
  weight; the most important information not the most prominent thing on the
  screen. Judged per form factor: what leads the eye at desktop must still
  lead it at phone, where the first screen is all a reader gets. This is the
  most valuable judgment you make, because it is the one a measurement could
  never catch.
- composition: the view as a whole does not read as deliberately finished.
  Several accents competing with no clear primary, decoration carrying no
  information, visual noise obscuring the content, a layout left unbalanced with
  no apparent reason. Two shapes of this are worth naming, because they are easy
  to see and easy to argue away. Structure that encodes nothing: step numbers on
  items that are not a sequence, eyebrow labels and dividers that separate
  nothing, so the reader looks for an order or a grouping that is not there.
  Emphasis spent everywhere at once: gradients, glows, shadows or accent colour
  on many unrelated elements, so no single element reads as the point of the
  screen and the decoration is easier to find than the content. Use this when
  the problem is the whole rather than any one element, and say specifically
  what produces the impression: a holistic finding that cannot point at anything
  is the taste this rubric asks you to leave out. A palette, a typeface pairing
  or a layout you recognise as a common default is not itself a finding; only
  its visible cost on this screen is.
- consistency: the same element rendered differently in the same view with no
  reason: two button treatments in one toolbar, mixed corner treatments in one
  card row, icons that plainly come from two families, one role in two accent
  colours (two different "primary" colours on controls of the same rank, so the
  reader cannot tell which action is the primary one).

{{include:panel-audience.md}}

{{amendments}}
