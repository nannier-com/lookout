---
"@nannier-com/lookout": patch
---

`lookout skills freeze` no longer enshrines claims about screens the project
stopped serving.

The frozen set is capped at twenty screenshots, and until now a settled finding
whose route or state had been deleted from `lookout.config.ts` could still take
one of those slots. The only thing keeping such a finding out was its PNG
happening to be absent, which is not a rule: `capture` prunes an out-of-config
shot from the report and deliberately leaves the pixels behind, because backlog
findings still point at them. So a project that had dropped four routes froze a
set where a quarter of the cases, and a fifth of the claims, were about screens
the app does not render, and those claims then gated every future skill
amendment forever, with no run left that could ever re-adjudicate them.

Selection now asks the same question `check` asks of a stored shot: is this
route, on this target, in this state, still something the config names? The
predicate that answers it moved to `src/config-scope.ts` so both callers share
one definition. Freeze also reports what it left out, since "nothing settled
yet" is the wrong thing to tell somebody whose verdicts are all about routes
they deleted.

Nothing is deleted from the evidence workspace: the backlog still references
those screenshots, and removing them would leave findings pointing at nothing.
A set frozen before this change keeps its stale claims until `lookout skills
freeze` is run again, which rebuilds the manifest from scratch.
