---
"@nannier-com/lookout": patch
---

Deterministic findings are joined to the elements they fired on, exactly at
capture time: axe target selectors and a new overflow offender path (both
overflow branches now name one) are re-queried against the live page and
matched to the provenance walk, landing as renderedBy on backlog findings
(refreshed each sighting) and reaching the placement judge's brief as "this
finding's element". An unresolved selector writes nothing: the join stays
exact or stays silent.
