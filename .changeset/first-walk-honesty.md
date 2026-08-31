---
"@nannier-com/lookout": patch
---

`check --first` (the UI play button's path) stops on standing findings and
never says "no issues found" over an open backlog. The walk used to branch
on newly-filed counts, so a repeat run over an unchanged app re-captured
every route and printed a clean bill while cache-served findings of open
issues stood; it now stops at the first route with anything standing,
walks routes that already carry open findings first (worst severity first,
so a repeat run costs one route's capture and zero judge calls), reports
"all already filed" honestly, gives the stopping route's issues their
placement (issues born on this path never reached the full check's sweep),
and a clean walk over a non-empty backlog says how much open work it could
not reach.
