---
"@nannier-com/lookout": patch
---

verify-fix can no longer close a conformance finding without the oracle that
filed it re-firing. The code ruling now resolves the design system the same
way filing does (config declaration applied), so a kit that exists only as a
declaration no longer files on `check` and auto-passes on `verify-fix` having
read nothing. A kit that stops resolving refuses the pass and points at
by-design adjudication instead of clearing every open finding. Members with
no recorded provenance are re-read by the conformance skill rather than
cleared by scanner silence, members naming no source file refuse to clear,
and `verify-fix --model` now reaches the conformance re-read.
