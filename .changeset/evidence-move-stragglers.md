---
"@nannier-com/lookout": patch
---

Two readers the evidence move left behind. `backlog merge` read the judge
report from the project's old `.lookout/evidence`, where `check` no longer
writes it, so a merge from disk silently dropped every AI finding; it now reads
the capture workspace under the operator's home, and still adopts a report an
older lookout left in the project. `lookout ui` printed that same old path in
its "watching" banner, pointing anyone debugging at a directory nothing uses.
