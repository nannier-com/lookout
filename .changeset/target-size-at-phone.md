---
"@nannier-com/lookout": minor
---

**Control size is measured at the width where a finger is the pointer.** axe
ships its `target-size` rule disabled, and lookout's default (`--axe route`)
scans once per route at the widest form factor, which is desktop. Between them,
no phone screenshot had ever been scanned and the one rule whose whole subject
is touch had never run anywhere. Meanwhile the visibility panel was asked to
file "touch targets too small or too crowded to hit reliably" from an image,
while the rubric rightly forbids it the measurement that would make such a
finding actionable.

The rule now runs at phone width on every rest shot, selected by name so it
runs whether or not it ships enabled. Findings arrive as ordinary accessibility
violations with the attribute `axe-target-size`, carrying the sizes axe
measured, and they account for spacing, so a small control with room around it
passes and a small control crowded by its neighbours does not. They open at
medium rather than at axe's own severity: what is measured is the element's
box, which is not always its hit area, and nothing refutes a deterministic
finding, so a possible false positive should not sit at the top of a backlog
with no second opinion available.
