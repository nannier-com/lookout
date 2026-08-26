---
"@nannier-com/lookout": patch
---

Key the judge cache by view group instead of by single shot.

The rubric asks the judge to compare a view's dark/light pair and its
form-factor progression, but the cache was keyed on one shot's pixel hash. On a
scoped re-check after a fix, the changed shot re-judged while its unchanged
partner was served from cache and never entered the batch, so the judge was
asked for a comparison with one side missing and quietly stopped filing it. A
colour-scheme or responsive finding therefore read as fixed when nothing had
been fixed.

A view group is now one target + platform + route + state across every form
factor and scheme; its cache key covers every member's pixel hash, so any member
changing re-judges the group whole. Batching treats a view group as atomic: an
oversized group ships alone rather than being split across batches. Existing
ledger entries miss once and re-warm.
