---
"@nannier-com/lookout": minor
---

lookout check now discovers and exercises a route's interactive affordances.
Capture harvests every route's buttons, links, and CTAs; the new
plan-navigation skill curates them into a cached interaction plan (re-planned
only when a route's affordances change, capped per run); and capture executes
the plan as first-class states, so the judges rule on overlays, tabs,
post-click pages, and dead CTAs instead of only the initial render. Opt in
with navigation.enabled in lookout.config.ts; lookout clicks everything by
default, including destructive controls, ordered last with sign-in recovery,
so point targets at a disposable environment and use navigation.exclude for
anything untouchable. New flags: --no-navigation skips discovery for a run,
--navigate forces a re-plan.
