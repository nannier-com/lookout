---
"@nannier-com/lookout": minor
---

Web capture now records rendering provenance: beside every shot lands a
`<shot>.png.provenance.json` sidecar mapping the rendered elements (geometry
in document CSS px, ids, test ids, classes, text, CSS paths) to the
components and, where the page's dev tooling exposes it, the source files
that produced them (React dev fibers, Vue, Svelte, and data-source style
attributes; production builds honestly degrade to element identity). The
sidecar carries an exact pixel-mapping envelope (origin, scroll, viewport,
actual PNG size) that stays correct for element crops and Chromium-clamped
tall pages. On by default: the walk is passive, read-only, spends no model
money, and a failure never costs the shot; disable with `provenance: false`,
a per-route `provenance: false`, or `--no-provenance`. Provenance is not a
judge input: it enters no cache identity and no fingerprint.
