---
"@nannier-com/lookout": patch
---

`verify-fix` gives up the last thing that was not a ruling: gathering the
evidence. `verify/evidence` re-captures and re-judges the issue's own routes,
folds the result into the backlog, and works out which screenshots actually
moved. That last part is computed once and handed to both the verdict and the
acceptance criteria, rather than derived twice, because it is the load-bearing
guard: a shot with no baseline is not evidence of change but evidence of
nothing, and counting it as changed once let a cleaned evidence directory
satisfy the rule that nothing may pass on unchanged pixels.

The verb is now under the size ceiling and comes off the exemption list. Only
`design/detect`, `design/conformance` and `judge/engine` remain pinned.
