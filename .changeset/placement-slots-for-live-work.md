---
"@nannier-com/lookout": patch
---

Placement slots go to live, locatable work only: the sweep now considers
open issues alone (fixed, by-design and archived ones no longer spend the
cap) and skips code-channel issues, whose documents already carry the exact
path, line and symbol. Failures are counted and reported instead of
silently consuming slots (an all-fail sweep used to print nothing while
spending money), the run summary carries the cost, and `--max-placements 0`
says "off (cap 0)" instead of promising leftovers the cap guarantees will
never be placed.
