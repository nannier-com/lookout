---
"@nannier-com/lookout": minor
---

Add auto mode: `lookout check --auto`, `lookout verify-fix`, and `lookout
backlog plan`.

New user-visible capability. lookout is executed by agents rather than read by
people, so auto mode turns a backlog into work an orchestrating session can
dispatch, and then rules on the result. lookout still edits nothing and spawns
nothing.

- `check --auto` clusters open findings by root cause (one target + category +
  attribute; co-located accessibility violations group by route, because an axe
  rule id names the rule that fired rather than the thing that is wrong), writes
  one self-contained brief per cluster under `.lookout/evidence/fix/`, and emits
  a `PLAN.json` carrying the dispatch protocol. Each brief is a complete prompt:
  the defect, the screenshots to read, the repository to change, the rules, and
  the JSON the fix session must reply with. The orchestrating session therefore
  holds cluster ids and verdicts rather than findings.
- `verify-fix --cluster <id>` re-captures and re-judges only that cluster's
  routes and rules on the claim: exit 0 passed (backlog adjudicated to fixed
  with the commit), 1 not fixed (a fresh brief is written carrying what the
  judge still sees, for a new session), 2 execution error, 3 blocked after
  exhausting `--max-attempts` (default 2, recorded with a mandatory reason). A
  fix session never grades its own work.
- `backlog plan` re-emits the same dispatch plan from the backlog alone, so
  resuming a fix loop costs nothing.
- `--severity` sets the dispatch floor, critical and high by default.
