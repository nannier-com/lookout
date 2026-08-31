---
"@nannier-com/lookout": patch
---

`verify-fix` gives up two pieces it should never have held. Ruling a code-channel
defect is `verify/code`: those findings come from reading source, not pixels, so
re-capturing proves nothing about them and they are ruled by re-reading the
code. Ruling the acceptance criteria is `verify/acceptance`, where each source
is decided by the thing that can decide it: the deterministic checks rule their
own, the pixel hashes rule the re-capture guard, and the judge-authored ones get
an independent look at the new screenshots.

The verb keeps what is actually its job: work out what changed, rule, and record
the attempt.

No test calls `verifyFix`, so this was verified by running it: a real re-capture
and re-judge of an issue's own routes, the load-bearing guard refusing to pass
on byte-identical screenshots, four acceptance criteria ruled from three
different sources, and the attempt recorded.
