---
"@nannier-com/lookout": patch
---

The category vocabulary moves out of the monolithic rubric into six panel
skills (judge-integrity, judge-geometry, judge-visibility, judge-text,
judge-craft, judge-design-parity), composed back through the core rubric's
new {{panel}} slot. Judging behavior is unchanged: the rubric text is
regrouped, not rewritten, but the prompt hash moves, so every cached verdict
re-judges once on upgrade.
