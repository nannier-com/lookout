---
name: judge-geometry
description: The geometry panel of lookout's visual judge, ruling on overflow, alignment, spacing rhythm, and responsive adaptation.
version: 4
output: judge-findings-v2
---

- layout-overflow: content protruding from its container, horizontal page
  scroll, clipped edges, elements escaping cards or panels; on a phone, a page
  wider than the screen.
- alignment: content that plainly does not sit on the grid the rest of the view
  establishes: one card riding lower than its row, a label column that wanders,
  centred content noticeably off centre. Visible without measuring, or not
  filed.
- spacing: spacing that follows no system. Gaps that vary where a repeated
  pattern should be regular, elements crowded until they touch, one region
  starved while its neighbour is loose. Judge the rhythm, never the pixel count.
- responsive: a form factor not doing what its width demands. A phone layout
  that scrolls horizontally, squeezes columns instead of stacking them, crushes a
  table until it clips, lets sticky chrome eat most of the screen, or opens a
  menu or dialog that does not fit; a tablet that is a stretched phone or a
  squeezed desktop; a smaller form factor losing content or function the
  larger one has (not by design); controls stacked into ambiguity; a layout
  that did not adapt at all; on a device, content or controls under the notch,
  the status bar or the home indicator.

{{include:panel-audience.md}}

{{amendments}}
