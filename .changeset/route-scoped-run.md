---
"@nannier-com/lookout": minor
---

A run stops at the first route with issues, and files every issue on it.

The previous shape narrowed to a single worst issue at merge time. It held, but
it threw away real findings lookout had already captured and judged: a live run
filed one console error and discarded three other defects, two of them scheme
mismatches, which then had to be paid for again on the next run.

Scoping replaces narrowing. `--first` walks routes in config order, stops at the
first one that turns anything up, and files all of it. Nothing lookout did is
discarded, and nothing is claimed about the routes it never looked at.

That deleted more than it added. Gone: the finding-count limit and `--limit`,
the forced-serial judging that limit needed, the merge-time narrowing and the
"seen but not filed" accounting, and the optimisation that skipped the judge
when the capture had already found something. That last one was right when the
answer was one issue and wrong now, because a route's issues include the ones
only the judge can see.

The page says how far the walk got rather than how much it dropped: stopped at
this route, after looking at N of M, fix these and run again for the next.
