---
"@nannier-com/lookout": patch
---

**The adversarial verifier is handed lookout's own measurements, and rules on
acceptance criteria while it still has the evidence.** The verifier used to
receive a claim, a screenshot, and an instruction to lean refuted when
uncertain. That instinct is right and it has a cost: the findings hardest to
see in a still are the ones it kills, and some are real. Two refutations in one
stored run dismissed a control as a deliberate mobile simplification when
lookout had measured its box sitting past the right edge of the page and never
showed it.

Each finding now carries what was measured on its shot: the deterministic
checks that fired, what scrolls, and a short geometry brief from the provenance
sidecar naming the elements whose boxes leave the page. The skill says what
those lines are worth. A claim they contradict is refuted; a claim they prove
is confirmed even where the pixels are ambiguous; and a number the judge wrote
in its own prose is still invented and still refutable on that ground. This
costs no extra model call, and it re-keys every cached verdict once per project
because the verifier's text is part of every panel's prompt hash.

The same reply now rules each confirmed finding's acceptance criteria. A
criterion no screenshot could settle is replaced with an observable rewrite
where one exists and dropped where none does; one already true on the defective
shot is dropped, since it would read as met while the defect stood. Both used
to surface a whole fix cycle later as a not-verifiable verdict that blocked
nothing. Each drop becomes a signal for the panel that wrote it.

The frozen regression set now copies each case's measurements and its
provenance sidecar, so a replay grades an amendment under the evidence a real
run has rather than a thinner version of it. The rubric's rationale for not
naming another form factor is corrected in the same change: a judge is handed a
whole view, so a criterion naming another form factor from that batch was
always inside its evidence.
