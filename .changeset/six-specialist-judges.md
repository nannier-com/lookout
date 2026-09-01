---
"@nannier-com/lookout": minor
---

The visual judge is now six specialist judges, each its own agent per view
group. This minor adds the user-visible capability: specialized panel judging
(judge-integrity, judge-geometry, judge-visibility, judge-text, judge-craft,
and a design-parity judge that runs only when a design reference exists),
per-panel cached verdicts so amending one specialist re-judges only its own
rulings, the new --panels flag to narrow a run to named judges, and findings
that state which judge filed them. The regression replay now grades an
amendment by running exactly the claim-owning panels. Upgrading re-judges
every cached verdict once: the rules genuinely changed.
