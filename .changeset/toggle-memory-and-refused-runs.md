---
"@nannier-com/lookout": patch
---

The tool picker survives a refresh, and a refused run says why.

Two defects the page shared: it threw away an answer it already had.

The picker reconciled what the browser remembered against the tool list before
that list had arrived. An empty list is the fetch not having landed yet, not a
machine with no tools on it, so every remembered key was filtered out as
unknown and the selection reset to the first tool on every refresh. The
reconciliation now waits for a list with something in it.

The play button posted to `/api/check` and discarded the reply. The server
refuses a run for reasons a person can act on, and says which in the 409 it
answers with: a target that is down, a device that is not booted, an issue
being fixed in that tree right now. All of it was dropped, so the button was
indistinguishable from one wired to nothing. The reason now lands in the notice
beside the project path, where every other refused request already went.
