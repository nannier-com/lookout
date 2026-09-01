---
"@nannier-com/lookout": patch
---

The judge names, per finding, which part of the frame the defect lives in:
content, shell-nav, shell-header, or shell-footer, a closed vocabulary in the
reply contract (judge-findings-v2, skill v5). An unknown or missing region
degrades to content with an incident, never a rejected finding. Shell-regioned
open findings now travel to every batch's ALREADY FILED aid, so different
routes reuse one name for one chrome defect instead of each minting a fresh
attribute; until a project has any shell finding, its open findings travel
instead, capped worst-first. The region is stored on the backlog record
(adopted on refresh where none was recorded, never overwritten) but does not
change any fingerprint yet: identity moves in a later release, after regions
have accumulated to inspect. The rubric also states, promoted from a lesson a
project layer learned, that problem text and acceptance criteria are written
from the screenshot in front of the judge alone.
