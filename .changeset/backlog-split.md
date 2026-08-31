---
"@nannier-com/lookout": patch
---

`backlog/lib.ts` was 742 lines carrying five unrelated jobs behind banner
comments. Each banner is now a file: `backlog/fingerprint` (the dedupe identity,
axes only and never prose), `backlog/ingest` (the three channels mapped into one
shape), `backlog/merge` (the reopen and suppress state machine, and the status
transitions that are its other half), `backlog/check` (whether the file still
tells the truth), and `backlog/report` (the counts and the deterministic
markdown).

`lib.ts` keeps the shapes, which is what most of its thirty-one import sites
want, and re-exports the rest, so nothing that imported it had to change. Each
name is still defined in exactly one place. It comes off the size-ceiling
exemption list.
