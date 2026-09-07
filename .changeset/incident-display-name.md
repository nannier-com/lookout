---
"@nannier-com/lookout": patch
---

An incident's `project` is only trusted when it is an absolute path.

`incidentLogDir` handed whatever it was given to `locateConfig`, which resolves
against the working directory and climbs to the nearest `lookout.config.*`. A
display name such as "p" — which is not a directory at all — therefore found the
config of whichever repository the process happened to be standing in and logged
there, bypassing the checkout `LOOKOUT_CHECKOUT` had pointed it at. Two of the
self-heal tests failed from this the moment `lookout ui` was run inside lookout's
own checkout, because that writes a `lookout.config.ts` at the repository root by
design. The field was always documented absolute; it is now enforced.
