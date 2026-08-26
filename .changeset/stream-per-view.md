---
"@nannier-com/lookout": patch
---

Judge one view group per call by default (batch size 6, was 10).

A view group, one route and state across its form factors and schemes, is
already the unit the rubric compares within, so a larger batch buys the judge no
context it can use. It does hold every finding in the batch hostage until the
whole batch returns: on full-page screenshots that ran to several silent
minutes, which defeats the point of streaming. `--batch-size` still overrides.
