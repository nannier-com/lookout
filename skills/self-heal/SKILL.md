---
name: self-heal
description: Fix the cause of a failure in lookout's own source, in its own checkout, without weakening anything that would catch the failure again.
version: 1
output: self-heal-report-v1
---

# Healing lookout itself

You are editing lookout's own source, in the checkout at {{checkout}}. Below is
its incident log: failures recorded across every project this machine has run
lookout against, grouped by shape, most frequent first.

Pick the one you can fix properly and fix its cause. One incident group per run.

{{amendments}}

## What you may touch

Only files under this checkout. Nothing in a target project, and nothing under
any `.lookout/` directory anywhere: those hold other projects' records, and a
tool that edits the evidence it is judged by is worthless.

Do not run commands. lookout runs the gates itself when you are done, precisely
so that whether they pass is not your own report of them.

## The bar

The gates are `tsc --noEmit`, `eslint`, `bun test`, and the build, all of which
must pass, plus a replay of a frozen set of already-adjudicated screenshots when
one is available. If any fails, everything you wrote is reverted. That makes the
following pointless as well as wrong:

- Deleting, skipping or loosening a test so the suite goes green. The test is
  the thing that would catch this failing again.
- A workaround where the cause is reachable. If the fix is genuinely too large
  for one pass, say so in `summary` and change nothing.
- Anything speculative. Fix what the incidents show, not what you suspect.
- Version numbers, CHANGELOG entries or changesets. lookout writes those.
- Widening what a subprocess is allowed to do, or what a target may reach.

Where the incidents show a failure that is really a missing capability rather
than a bug, say that in `summary` and change nothing: wiring a new capability
is a decision, not a repair.

Add a test that fails before your fix and passes after it, unless the change is
genuinely untestable, in which case say why in `summary`.

Match the surrounding code. This codebase explains WHY in comments, not what,
and it says things plainly.

## The incidents

{{incidents}}

## Output contract

Reply with ONLY one fenced json block, no prose before or after:

```json
{
  "incident": "<the grouped message you fixed, copied from above>",
  "summary": "<one line: the cause, and what you changed>",
  "cause": "<what was actually wrong, in a sentence or two>",
  "files": ["<path you edited, relative to the checkout>"],
  "test": "<the test that now covers it, or why none was possible>",
  "changed": true
}
```

Set `changed` to false, with `summary` saying why, when the right move is to
change nothing.
