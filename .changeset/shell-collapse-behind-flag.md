---
"@nannier-com/lookout": patch
---

Behind the new `shellScoping` config flag (default off), a finding the judge
places in a shell region is fingerprinted by that region instead of its route,
and the route-scoped records it supersedes fold into it as it is re-found: one
chrome defect becomes one finding carrying the union of its history. Status
folds by precedence (by-design over blocked over open over fixed) so an
adjudication is never lost, the folded record keeps its earliest first-seen,
its routes in `seenRoutes`, and the old fingerprints in `absorbed` as the
audit trail; each collapse is narrated to the event log. Records whose region
was explicitly answered `content` are never absorbed. Off by default for a
release so regions accumulate inspectably before any identity moves.
