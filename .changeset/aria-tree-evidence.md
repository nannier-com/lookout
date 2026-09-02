---
"@nannier-com/lookout": minor
---

Minor justification (new public capability): every web shot now carries the page's accessibility tree as evidence, and two judge panels rule with it; `aria: false` and `--no-aria` are the new ways to decline it.

**The judge gets one piece of evidence that is not a picture.** Beside every web screenshot lookout writes `<shot>.png.aria.json`, the accessibility tree as Playwright reports it: each meaningful element as a role, its accessible name, and for some controls its state. The integrity and text panels are given it in their prompts. Both were inferring from pixels things the tree states outright, so a dialog whose tree holds a `button "Close"` has its dismiss affordance whatever the picture suggested, a `textbox "Email address"` has its label, and a paragraph the layout cut off with an ellipsis reads whole in the tree, which turns "that looks truncated" into a finding worth filing. Their skills say the other half too: a finding the tree contradicts is not filed, the tree says nothing about how anything looks, and a tree cut for length proves nothing by what it omits.

Geometry, visibility and craft are not shown it, because it is evidence about what exists and they rule on how things look. It is a verdict input for the two that are, so it enters their cached verdicts' identity the way a design hand-off does: changing an `aria-label` re-judges those two and leaves the other three cached, with no pixel moved. Native captures have no DOM, so they carry no sidecar and their prompts promise none.

`aria: false` in `lookout.config.ts`, or `--no-aria` for one run, turns it off. `judge-integrity` and `judge-text` rise to version 4, so their standing verdicts are re-judged once.
