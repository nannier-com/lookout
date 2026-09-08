---
"@nannier-com/lookout": minor
---

A project can declare the colour schemes it ships, and lookout stops photographing and
judging a scheme it does not have.

`scheme` says how an app switches appearance. The new `schemes` says what there is to
switch to. Left out, both are still walked, because a project that has not said cannot be
assumed to have one. Set, the walk is exactly those.

This closes a false finding. Every route used to be photographed in dark and light
whatever the project shipped, so an app with a single appearance produced two identical
captures, and two identical captures read as a scheme mechanism that failed. lookout was
asserting a capability the project never claimed. A project that declares one scheme is
now photographed once per route, which also halves its shots, and the byte-identical check
cannot fire because there is no pair to compare.

Where nothing is declared and the captures do come out identical, the finding now names
both causes it could have: a scheme switch that did nothing, or a project that ships one
appearance and should say so.
