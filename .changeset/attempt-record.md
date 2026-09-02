---
"@nannier-com/lookout": patch
---

**The attempt record says what the ruling saw.** `state.json` kept one
sentence about each attempt; everything else the ruling knew (how many
screenshots were compared and how many moved, which findings were still
filed and what the judge said about each, which criteria failed and why, the
contact sheet, the flags that narrowed the capture) was printed to stdout and
lost. Each attempt now records all of it, plus what lookout observed in the
repository at ruling time (HEAD, the uncommitted files with `.lookout/`
excluded, and the files changed since the previous attempt's commit), kept
apart from what the fixer reported so a claim is never filed as lookout's own
fact. The issue document prints every one of these under the attempt, in the
order a second attempt needs: what was reported, what lookout observed, what
it saw, then the verdict.

The acceptance verifier's `evidence` (which shots decided a criterion) and
`suggestion` (what it would change) used to be dropped when its answers were
matched back onto the criteria; they are kept now, written onto the criterion
beside its note, and printed under it in the document.
