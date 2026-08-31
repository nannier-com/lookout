---
"@nannier-com/lookout": patch
---

The adversarial verifier now reaches every AI finding. The old boundary
(critical/high plus six quality-band categories) contradicted the rubric's
own severity ladder and left design-parity, color-scheme and responsive
findings unrefuted at medium and low. With the boundary gone: the refuter
retries once and records an incident when it fails twice, a refuter
subprocess failure no longer throws the judge's cached work away, cached
groups holding never-refuted findings are repaired on the next run by a
capped refute-on-read pass, and the frozen regression set can harvest
verified mediums (lows stay out deliberately: the most judge-variant claims
would make the improve gate flaky).
