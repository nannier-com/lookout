---
"@nannier-com/lookout": minor
---

The contact sheet is back: `capture`, `check` and `verify-fix` composite every
shot into one labelled image again.

Restored user-visible capability. The sheet went out as collateral when auto mode
was removed, and the README kept promising it: a session driving lookout could
not see what lookout saw without reading a dozen full-resolution screenshots,
which costs more context than the findings do.

A view's dark and light captures sit side by side, because that is the comparison
the rubric cares about most; tiles are cropped from the top so a tall full-page
screenshot still shows its above-the-fold region at a readable scale; and tiles
carrying findings are marked with the count, so `check` and `verify-fix` produce
a sheet that says where to look. The full-resolution paths are still printed
beside it for close reading, and the judge never sees the sheet: it judges the
originals, because a downscaled crop would hide the defects it is looking for.

`capture` writes `contact-sheet.png` in the evidence directory, `check` writes
the same with defect tiles marked, and `verify-fix` writes
`verify-<issue>.png` for the scope it re-captured. The path is printed and
appears as `contactSheet` in `--json` output. A sheet that cannot be built (an
image that will not decode, sharp unavailable) is skipped: it is a convenience,
and it must never fail a run that captured evidence and judged it.

This also clears the debris the removal left behind: an orphaned doc comment, an
uncalled helper, and a findings-per-shot map that was computed and never used.
