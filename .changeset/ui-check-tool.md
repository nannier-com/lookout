---
"@nannier-com/lookout": patch
---

The gate for anything the page renders is now a tool rather than a paragraph
telling you to build one. `tools/ui-check` has four commands: `fixture` builds a
throwaway project with something in every part of the page (an open issue with
evidence and criteria, one adjudicated, a history of lookout amending its own
instructions including a rollback, a frozen set, an incident log, a reverted
heal and a checkout with two that stuck), `serve` points the ui at it, `shots`
captures eight views across both colour schemes and a narrow viewport, `diff`
compares two captures and crops whatever moved, and `drive` runs sixteen
interaction checks.

The fixture backdates its evidence so the page's one relative clock renders in
whole days. That is what makes the comparison binary: two captures of unchanged
code come out ALL IDENTICAL and exit 0, rather than differing by a hundred
pixels of digits and leaving the reader to decide whether that mattered. Both
directions were checked: a six-pixel padding change is caught as 4.4% of the
board and a non-zero exit.

Development only; `tools/` is not published.
