---
"@nannier-com/lookout": patch
---

Fix `verify-fix` passing a deterministic cluster that never got fixed.

The ruling compared the cluster against freshly judged findings only. Rule
violations come back from capture rather than from the judge, so an
accessibility cluster (every `axe-*` finding) matched nothing on re-check and
was marked fixed with its violations still firing, which is the one outcome the
oracle exists to prevent. It now compares against both channels.
