---
"@nannier-com/lookout": minor
---

**`lookout backlog check --strict`, and lookout counts the findings a judge
wrote for one reader.** A finding whose `problem` fails the two-part bar
(the title again, a single paragraph, a rule id where a plain sentence
belonged) is still filed: rejecting it would throw away a real defect over
its prose. It is now counted at ingestion, one incident per batch, and
written to the judge report as `degraded`, where `skills improve` reads it
as a signal of kind `unreadable` attributed to the panel that wrote it.
`backlog check` reports each such record as a warning
(`problem-unexplained`) that does not fail the check; the new `--strict`
flag makes warnings fail, for a gate that wants every record readable on
its own. The mock judge's default finding meets the bar, so the suite's
runs stay clean.

Minor because `backlog check` gains a new option, `--strict`.
