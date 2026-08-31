---
"@nannier-com/lookout": patch
---

The conformance read fires only on full-scope checks: a route-scoped run
(`--targets`/`--routes`) skips the source sweep with a reported note, since
the sweep reads the application's source rather than the captured route and
a tight fix loop was paying it every iteration; an explicit
`--max-conformance` is explicit consent and overrides. `check` gains
`--no-cache` (the judge ledger serves nothing but writes fresh verdicts;
the conformance reader neither serves nor writes). Full sweeps retire
conformance cache entries whose files left the tree. A reader refutation of
an already-open finding, previously paid for and thrown away, now surfaces
as a disagreement note carrying the ready-to-paste by-design adjudication
command; nothing is auto-closed. `design-system --audit` says out loud that
its verdicts warm the cache the next check files from.
