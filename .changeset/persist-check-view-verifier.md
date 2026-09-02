---
"@nannier-com/lookout": patch
---

**A finding keeps what the check recorded, how the view was photographed,
and what the verifier said.** A deterministic finding survived ingestion as
an attribute, a region and one rendering element; the rest of the check's
record (every element a rule fired on, the error's location, the offending
path, the reference link) was written into prose once and then gone, and the
adversarial verifier's own account of why a judged finding stood was dropped
outright. Each finding now carries `check` (the check's type and its record,
bounded: strings to 400 characters, lists to 20 items, nesting to two levels,
the provenance join left out since `renderedBy` and the sidecar carry it),
`view` (whatever capture recorded about how the view was photographed:
today the design hand-off, its hash and the sidecar path; more as capture
records it) and, on the AI channel, `verifierNote`. All three are refreshed
when a newer sighting carries them and never cleared by one that does not.
The issue document lists the check's record key by key under each
deterministic defect ("What the check recorded") and prints the verifier's
account under each judged one. `backlog check` rejects an unknown check type.
