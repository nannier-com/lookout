---
"@nannier-com/lookout": patch
---

verify-fix re-judges an AI cluster with only the judge panel that owns its
category; the sibling panels' standing findings still serve from their cached
verdicts, and moved pixels still invalidate every panel at once, so closure
is always backed by a fresh judgment. backlog check learns which panels the
last judge run actually asked, so a panel-scoped run never reads as
drift-resolved for the lanes it deliberately skipped.
