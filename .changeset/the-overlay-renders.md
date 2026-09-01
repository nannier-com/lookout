---
"@nannier-com/lookout": patch
---

The shot inspector draws its provenance overlay: element boxes projected onto
the image as percentages of its intrinsic size (per the sidecar's own mapping
contract, so any display size and clamped captures stay exact), innermost
element winning hover, click pinning the hint: component chain, source
file:line, a concrete DOM handle, and the element's text. Frozen fix-frames
never advertise a sidecar: they are copies served from outside the evidence
root; the live tile carries the inspector.
