---
"@nannier-com/lookout": minor
---

lookout learns automatically. `check` and `verify-fix` now end by running
`skills improve` when the project has accumulated enough NEW evidence: three
new signals, or a single new by-design adjudication (a person wrote a rule
down; it should not wait). The frozen-set replay gate still decides whether
an amendment survives, the auto path never spends when the outcome could
only be an unapplied proposal, and an improve failure is an incident, never
the run's failure. The spend is visible (narrated, in the event log, and as
a `learned` field under `--json`), capped by a 24-hour cooldown, and
declinable three ways: `--no-improve` for a run, `learn: { auto: false }`
in the config for good, and CI environments never auto-learn. `learn.
threshold` and `learn.cooldownHours` tune it; `lookout protocol` documents
it.
