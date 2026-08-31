---
"@nannier-com/lookout": patch
---

The judge cache's identity now covers every design input: a route's hand-off
image contributes its bytes to the view group's hash (swapping the PNG
re-judges the views that point at it), and handoff.md joins the prompt hash
(editing it re-judges what it could have changed). Groups without designs
keep their existing hashes, so no cache is invalidated by the upgrade
itself. The prior-findings block stays out of the key, now documented at the
store: it is a naming aid, and adjudications are enforced at merge.
