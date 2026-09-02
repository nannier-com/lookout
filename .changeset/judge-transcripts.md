---
"@nannier-com/lookout": patch
---

**Each panel's reply is kept, and the issue points at it.** The judge's raw
reply was distilled into title, problem, expected, observed and acceptance
and then discarded. Every panel call now writes its reply whole to
`judge-replies/<group>@<panel>.txt` in the capture workspace (overwritten
like a screenshot, never in git), the ledger entry for that verdict carries
the file's path, and the issue document and `Issue.json` list, under
"Artifacts", every transcript behind the issue's own views that is still on
disk, by panel and run.
