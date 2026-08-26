---
"@nannier-com/lookout": minor
---

Feed the session while the run is still going, show a person what is happening,
and carry the operating contract in the tool rather than in one vendor's plugin.

New user-visible capability across three fronts.

**Live feedback.** A run takes minutes and a subprocess's stdout does not reach
its caller until it exits, so lookout now narrates to
`.lookout/evidence/events.jsonl` as it goes. `lookout status` folds that into
"what is happening right now" for an agent to poll (exit 1 while a run is in
flight), and `lookout ui` serves a local page that renders the same log live,
with screenshot thumbnails, findings as they are confirmed, dispatched clusters
and their verdicts. Both read the log, so either can watch a run started by
anything, anywhere.

`check --auto` now streams its dispatch instead of batching it to the end.
Deterministic clusters go out before judging even starts, since rules cannot be
contradicted by a judge, and each judged cluster goes out as soon as the routes
it touches are done. Verification moved to a per-batch pass to make that
possible. A cluster that grows after it was dispatched is re-emitted as an
amendment rather than silently left stale, and `verify-fix` re-judges the whole
cluster scope, so a partial fix comes back still-open with a fresh brief.

**Seeing what lookout saw.** `capture`, `check` and `verify-fix` composite every
shot into one labelled contact sheet, with a view's dark and light captures side
by side and defect-carrying tiles marked. One image answers "what does this
actually look like" for the cost of a single read, and full-resolution paths are
listed beside it, absolute, for close reading. Each fix brief carries its own
cluster sheet.

**Agent-agnostic by construction.** `lookout protocol` prints the operating
contract: what lookout is, the loop, the dispatch protocol, the exit codes and
the rules. It lives in the tool so any agent can read it, not in a Claude skill
that other harnesses cannot see and that would drift from the code. Brief
wording no longer assumes one harness's tool names.

**Project rules are named, not assumed.** lookout hands work to an agent whose
configuration it cannot see, so every brief now discovers and lists the rule
files governing the target repository (CLAUDE.md, AGENTS.md, GEMINI.md,
CONVENTIONS.md, .cursorrules and the like, in the repo, its subtree and its
ancestors) and requires them to be read before any edit, with the project rule
winning wherever it conflicts with the brief.
