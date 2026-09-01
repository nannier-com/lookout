---
"@nannier-com/lookout": patch
---

The judging work unit becomes (view group x panel): panels of one group run
sequentially inside a worker with one pooled refuter call per group, a failed
panel poisons only its own cache entry, replies are held to the panel's lane,
every AI finding is stamped with the specialist that owns its category, and
--panels narrows which panels judge while cached verdicts still serve. With
the single transitional panel shipped today, behavior is unchanged.
