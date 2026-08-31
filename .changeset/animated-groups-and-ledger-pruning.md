---
"@nannier-com/lookout": patch
---

Animated views stop re-judging forever. Captures disable CSS animation, so
an animated view's stored still is usually byte-stable, and when animation
leaks into pixels the group hash misses on its own; the cache veto
therefore bought only judge variance while writing ledger entries nothing
could read. The cache now serves on hash identity alone, the judge prompt
instead marks such shots as one frame of a moving view, animation
detection covers state recipes (where spinners actually live) instead of
only the rest state, and full-scope checks prune ledger entries no current
capture can reach, so the committed cache stops growing monotonically.
