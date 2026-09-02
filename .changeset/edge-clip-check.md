---
"@nannier-com/lookout": minor
---

**A new deterministic check: content clipped where nothing scrolls.** The
horizontal-overflow check files only when the document itself scrolls sideways.
A control pushed past a header with hidden overflow, or a table column cut off
by the panel that holds it, produces no page scroll at all, so that check
computed the offending elements and threw them away. What was left to notice it
was a judge reading an image, which the rubric rightly forbids from measuring:
the finding arrived as an eye-judged claim under whichever category the panel
that happened to run owned, and the adversarial verifier could refute it by
calling the missing content a deliberate responsive collapse. A box is not
arguable.

`edge-clipped` is measured at every shot from the live boxes, files under
`layout-overflow` with the attribute saying what did the clipping (the viewport
or an ancestor that hides its overflow), names the elements it measured with
their own on-screen text, and arrives already verified at no model cost. Where
every offender sits inside the same landmark, the finding takes that shell
region, so one clipped header control is one defect for the application rather
than one per route.

It stays silent about everything that leaves its box on purpose: content inside
a horizontal scroller (it is reachable, and the scrollers are recorded on the
shot instead), a label truncated with an ellipsis or a line clamp, anything
hidden, transparent, or collapsed, and any subtree a project names in the new
`checks.edgeClip.ignore` config. `--no-edge-clip` turns it off for a run;
`verify-fix` refuses that flag for the same reason it refuses `--axe off`,
since a criterion about clipped content would otherwise be ruled met without
anything being measured.
