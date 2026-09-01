---
"@nannier-com/lookout": patch
---

The frozen-regression gate no longer rolls back an amendment for the judge's own
run-to-run spread.

Measured on a 63-claim frozen set, replaying with the skills completely
unchanged lost 6 claims on one run and 22 on the next, all of them "lost". Since
`skills improve` rolls a candidate back on any violation at all, a baseline that
reliably violates closed the gate permanently, and reported it as "the amendment
broke settled verdicts".

Two causes, both addressed without weakening the check:

- A mustFile claim is now satisfied when its PANEL filed something on that shot,
  not when that exact category came back. A panel owns several categories and
  moves a defect between them freely: composition kept 15 of 15 while
  consistency kept 0 of 6, both judge-craft, and every lost consistency claim sat
  on a shot where a composition claim was retained. The panel is already the
  gate's unit of causation, since only the amended panel replays. When the label
  does move it is reported as drift rather than discarded. mustNotFile keeps its
  exact category: widening that direction would invent violations, not remove
  them.
- A violation must now be evidence rather than one sample. It is re-judged until
  it has recurred every time, and what survives is judged once more with the
  candidate withdrawn. A claim the unchanged skills lose too is reported as
  stale instead of blamed on the amendment. Both rounds re-judge only the view
  groups in dispute, so a clean replay costs exactly what it did before.

`skills improve` still demands zero violations; there is no tolerance threshold.
`skills replay` prints drift alongside violations and says that one replay is one
sample.
