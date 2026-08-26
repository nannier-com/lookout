---
"@nannier-com/lookout": minor
---

The tool toggle shows marks instead of words, and contact sheets are gone.

The navbar toggle is now two logo marks rather than two labels: a burst for
Claude Code, a six-lobed knot for Codex, each with the tool's name as its
accessible label and tooltip. They are lookout's own drawings, not the vendors'
official logos, which are trademarks lookout has no copy of and would only
reproduce badly from memory. A project that wants the real thing drops an SVG at
`.lookout/logos/claude-code.svg` or `.lookout/logos/codex.svg` and lookout uses
that instead; a file that is not a lone `<svg>`, or that carries script, is
ignored, because the markup goes straight into the page.

Contact sheets are removed: `buildContactSheet`, the per-issue sheets, the
run-level `contact-sheet.png`, the navbar link, the sheet tile on every card,
and the sheet line in handoff documents and `lookout status`. Compositing every
capture into one image existed so that a fix session could see a whole defect in
a single read. Nothing works that way now: the UI shows the screenshots inline,
and the handoff lists them individually by absolute path. The one thing lost is
that an agent reading a handoff opens N images rather than one.
