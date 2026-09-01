---
"@nannier-com/lookout": patch
---

`mergeLatest` rejects a capture report with no runs instead of crashing on it.

Every finding a merge files is stamped with the latest capture run, read off
`report.runs[report.runs.length - 1]`. The existing guard only asked whether
`capture-report.json` was there at all, so a report whose `runs` array was empty
got past it, the read came back undefined, and the merge died on
`TypeError: undefined is not an object (evaluating 'latestRun.id')`. It surfaced
through `lookout check --no-capture` against a hand-authored report.

`lookout capture` always records a run, so nothing in the normal pipeline can
produce one of these: the reports that look like this are truncated or written
by hand. That still makes them malformed input, and malformed input gets a
LookoutError naming the problem, as it does everywhere else in this file. The
crash also mattered beyond the message: `lookout self-heal` reads the incident
log, and an unhandled TypeError was recorded there as a lookout crash rather
than as the operator error it is.

The other three readers of `report.runs` were checked and left alone.
`backlog/check.ts` already tests the length. `verbs/verify.ts` and `verbs/ask.ts`
read the report immediately after `runCapture`, which appends a run through
`mergeRun` on every path and throws when nothing was captured, so their
assertion is an internal guarantee rather than a boundary read.
`verify/evidence.ts` optional-chains, and now goes through this guard first
anyway, since it merges before it re-reads the report.
