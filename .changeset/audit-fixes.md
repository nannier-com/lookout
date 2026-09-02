---
"@nannier-com/lookout": patch
---

**Seven defects found by auditing the last release, one of which filed findings against applications that had none.**

A route captured through an `element` selector is photographed cropped, but the affordance harvest walks the whole document, so the navigation planner could pick a control that sits outside the frame. Focusing it produced a crop identical to its rest twin and filed `focus-invisible` against an application whose focus indicator was fine, on a channel nothing refutes. A control outside the captured frame is now skipped with a reason, and hover is framed like the rest shot it is compared with rather than full-page, which also un-breaks `hover-silent`: a full-page hover could never hash equal to an element-cropped rest, so on those routes it could not fire at all.

The rest, in what they cost:

- `trimAria` was not idempotent, and every tree the judge sees is trimmed twice. Its own elision markers matched the text-run detector, so a run of twenty collapsed lines reported "1 more" on the second pass, and the trailing line-budget marker dropped the first pass's count entirely: an 800-line tree told the judge 181 lines were missing when 681 were. Both markers now carry their counts forward, and a run that ends the tree marks its loss at the run's own indent instead of at the page root, where a YAML block scalar reads it as a text node of the document.
- `verify-fix` reported measured moves the display cap had dropped as "not measured (no baseline pixels on hand)". The two remainders are now counted separately and said separately.
- A failed accessibility-tree write left `ariaHash` on the shot record without the sidecar, which cached a pixels-only verdict under a ledger key asserting the tree. The hash is written only after the file survives.
- `navigation.maxFocusStatesPerRoute` and `maxHoverStatesPerRoute` were never validated, so `"abc"` reached the planner's prompt verbatim while `slice(0, NaN)` silently turned the feature off.
- A control that will not show `:focus-visible` is now skipped, which is what the file header, the README and the release note all said it did; it was filing a `capture-error` per form factor and scheme on every run instead.
- The issue document told a fixer a focus or hover state was "reached by clicking" the control, which reproduces a different screen. `ViewFacts` carries the interaction now, so the document says it after the workspace is gone.

Plus documentation that had drifted: `judge-visibility` still asked the panel to judge control size by eye, which the rubric forbids and axe now measures; the axe impact sentence claimed a severity the ingest may have capped, and reads the real one now; and README and two code comments still justified the phone-only `target-size` hook with a form-factor gate that no longer exists.

The frozen regression set also carries the accessibility tree now. It froze the provenance sidecar and not the aria one, so `skills replay` graded `judge-integrity` and `judge-text` without evidence production gives them, on 60 of the set's 164 claims.
