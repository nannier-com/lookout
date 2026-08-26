---
"@nannier-com/lookout": minor
---

`--first` walks one route at a time, and Findings is folded into Issues.

Narrowing at merge time was too late to stop the thing that actually hurt: a
run still captured every route across every form factor and scheme before
judging anything. On a thirteen-route project that is seventy-eight screenshots
and several minutes to answer a question the first route usually settles.

`--first` now walks the application a route at a time, in config order, and
stops at the first route that turns something up. Each stop is a handful of
screenshots rather than the whole application, and if the capture already found
something the judge is skipped entirely, because deterministic findings are free
and certain. Measured on a real project: six screenshots, one issue, stopped
after one of thirteen routes, seven seconds, nothing spent on the judge. The
previous behaviour had reached forty-eight screenshots before it was stopped.

A run that finds nothing still costs a full sweep and says so, and one that
stops early says how many routes it looked at, because "one issue" would
otherwise read as a clean bill of health for an application mostly never seen.

The Findings section is gone. It showed the same screenshot and the same
severity as the issue above it, next to a pointer back to that issue: two cards
for one thing. The only content it carried that an issue did not was the judge's
own words, so those moved onto the issue card as a **What is wrong** block
listing every defect grouped under that root cause. Severity counts issues now,
which also makes the filter numbers mean the cards under them.
