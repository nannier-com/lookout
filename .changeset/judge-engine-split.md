---
"@nannier-com/lookout": patch
---

`judge/engine` held three unrelated jobs. The subprocess contract moves to
`judge/claude`, which is what every AI capability lookout has actually shares:
the judge, the refuter, the acceptance verifier, the conformance reader, the
skill amender and the healer all ask different questions the same way, and now
there is one place that knows how a reply is unwrapped. View groups and batching
move to `judge/grouping`, since that is the unit the rubric compares within, the
ledger caches by, and a batch is one of.

What is left is the prompt and the reply contract. `engine` re-exports the rest,
so nothing that imported it changed, and it comes off the size-ceiling exemption
list: only the two design modules remain pinned.
