---
"@nannier-com/lookout": patch
---

The judge ledger keys verdicts per panel: the key gains a panel segment
(groupHash@vN@panel@promptHash@model), entries record which panel ruled, and
pruning drops the unreachable four-segment keys of the old format. The whole
composed rubric rides as a single transitional "all" panel until the pipeline
judges panels separately, so behavior is unchanged beyond the one-time cache
re-judge the new key format owes.
