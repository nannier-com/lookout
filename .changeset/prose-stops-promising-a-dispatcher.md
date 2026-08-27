---
"@nannier-com/lookout": patch
---

The last prose promising a dispatcher is gone. The README and the machine
skill file stop describing `check --auto`, `backlog plan` and fix briefs,
none of which have existed since 0.10.0; the backlog error hint stops
advertising a `plan` subcommand that does not exist; and docstrings in
events, status, verify-fix, the board, the ledger and rule discovery now
describe what those files do today. The unused `EventLog.attach()`, which
existed for the removed `lookout agent` verb, is deleted.
