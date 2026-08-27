---
"@nannier-com/lookout": minor
---

The judge now rules on design quality against named best practice, and stops
asking itself for measurements it cannot take.

New user-visible capability: findings about hierarchy, typographic rhythm,
spacing as a system, whitespace, affordance, restraint and whole-view
composition, under a new `composition` category. The rubric previously drew one
line, "craftsmanship, not taste", which read as principled restraint but threw
away the judgment a vision model is best at. It solicited pixel-precision claims
(`alignment` "edges that should share a line", `typography` "baseline wobble",
`spacing` "double margins") that models confabulate, while forbidding the
holistic reading they are genuinely good at.

The rubric now sorts what it could say into three bands. **Execution defects**
(broken, illegible, overlapping, clipped) are filed without argument.
**Design quality** is filed on one condition: the finding must name the
principle it breaks and what that costs the person using the screen, which is
what keeps the band falsifiable enough to verify and to write acceptance
criteria for. **Product and brand decisions** stay protected: brand palette,
typeface, corner radius, density, copy tone. lookout still rules on what a
decision does in context, so a brand colour that leaves text unreadable is a
contrast defect, but never on the decision itself.

Two things were cut outright. Anything requiring measurement: the judge is told
it is reading an image and cannot measure it, so geometry findings are filed only
when the deviation is visible without looking for it and never quote a pixel
value. And anything a still image cannot show: `a11y` no longer asks about focus
order and `states` no longer asks about invisible focus, both of which invited
the judge to invent behaviour it could not see.

`composition` is added to the closed vocabulary rather than replacing anything.
Every existing category keeps its exact name, because a category is part of every
fingerprint and cluster key in every project backlog, and a rename would orphan
the findings filed under it. Only the descriptions changed.

The design hand-off instructions moved to `skills/visual-judge/handoff.md` and
are carried only when a shot in the batch has a `design:` reference. They were a
quarter of the rubric and the most nuanced passage in it, and every project
without hand-offs was paying that share of every judge prompt for rules that
could never fire.

The `visual-judge` skill is at version 4. Cached verdicts re-judge on the next
run, which is correct: they were formed under different rules. A project layer
under `.lookout/skills/visual-judge/` is unaffected and still applies on top.
