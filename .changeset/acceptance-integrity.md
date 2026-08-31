---
"@nannier-com/lookout": patch
---

A verify-fix pass may no longer rest on unruled acceptance. If the criteria
verifier dies (it now gets one retry) while the defect looks gone, the run
refuses the pass: exit 2, nothing closes, no attempt is spent, and the
unruled criteria are named; a stale ruling earned by another run counts as
unruled, so passes are earned per attempt. Verifier failures also land in
the machine-wide incident log instead of an event log the next capture
truncates. Code-channel issues get their own universal criterion ("the
oracle that filed this re-read the source") instead of a screenshot claim
blanket-marked met by a pass that photographed nothing, and each criterion
carries a note naming its oracle. When the 20-shot cap bites, the criteria
verifier now sees the most refuting shots first (changed member evidence,
then uncovered form-factor and scheme pairs) instead of capture order, and
the truncation is reported.
