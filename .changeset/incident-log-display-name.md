---
"lookout": patch
---

An incident's project must be a directory, so a display name can no longer file
lookout's failures in whatever repository the process is standing in.

`Incident.project` has always been documented as "absolute, and a directory
rather than a display name", but nothing enforced it. `incidentLogDir` handed
whatever it was given to `locateConfig`, which resolves a relative string
against the working directory and then climbs to the nearest `lookout.config.*`
— so a project of `"p"` silently named the enclosing repository, and the entry
was appended to that project's log.

The reach is wider than a mistyped field. A configured project beats the
`ownCheckout()` fallback, and `LOOKOUT_CHECKOUT` only redirects the fallback, so
a display name was the one route past the isolation the whole test suite depends
on. Proved: run `lookout ui` in lookout's own checkout, which writes a config at
its root by design, and `bun test` then wrote six invented judge-contract
failures into that checkout and failed two self-heal tests, because self-heal
legitimately reads the log of the project the run was started in and found the
suite's fabrications in it.

`incidentLogDir` now offers only an absolute path to `locateConfig`. Anything
else is not a project in scope, and an incident with no project in scope goes
where it always did, to lookout's own checkout, so no failure is lost. Every
production caller already passed an absolute directory — `--config` is
absolutised before a project root is derived from it — so nothing that was being
recorded correctly moves.
