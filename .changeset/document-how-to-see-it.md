---
"@nannier-com/lookout": patch
---

**The issue document says how to see the defect and where everything lookout
wrote about it lives.** A "How to see it" block per photographed view gives
the URL with the colour scheme already in it, the viewport in CSS pixels and
the scale the PNG was taken at, how the scheme was applied (browser
emulation, a url parameter, or the config's recipe), the element when only
one was framed, what a state other than rest is and what lookout clicked to
reach it (from the navigation plan, or the config's recipe description), the
design hand-off the view was judged against with its hash, the provenance
sidecar beside the screenshot with how many elements it names and whether
the shot has been re-captured since, the workspace screenshot, and when and
by which run it was captured. Facts reconstructed from the config are marked
"(per the current config)"; facts the capture recorded win over them.

"Where it renders" now draws on the sidecars for every member, so a judged
finding, which carries no element of its own, gets the same list of named
elements with component chains and source hints that a check's finding did.
An "Artifacts" section names the config, the backlog, the judge ledger, the
navigation plan, the capture and judge reports, the run log and the contact
sheets, absolute, each only when it is on disk.
