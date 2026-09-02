---
"@nannier-com/lookout": patch
---

**A ruling says how far the pixels moved, not just that they did.** `verify-fix` compared screenshots by hash, so a one-pixel nudge and a whole re-layout were the same answer. It now decodes the baseline and the fresh capture and measures: the verdict prints one `moved:` line per changed screenshot naming the percentage, the size and position of the region that moved, and by how much the view grew or shrank when it did ("the view is 1836px taller; 56% of pixels changed, scattered across a 2880x3636 area down the whole view"); `--json`, `state.json` and the issue document carry the same figures, the document naming the largest move. Changed screenshots whose baseline pixels are no longer on disk are counted and said to be unmeasured, rather than left out where their absence would read as barely moving.

The guard itself is no weaker: a measurement can only move a screenshot from changed to unchanged, and only by proving the two images are identical, which closes the case where a re-encode of the same pixels between filing and ruling hashed differently and let judge variance pass. Two notes that claimed the screenshots were "byte-identical" now say "identical pixel for pixel", which is what the rule actually checks.
