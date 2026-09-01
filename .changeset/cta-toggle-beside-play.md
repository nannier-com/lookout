---
"@nannier-com/lookout": minor
---

**The play button can click the application's calls to action.** Two new
user-visible things: a toggle beside the button on `lookout ui`, and a
`--navigation` flag on `check`.

Navigation discovery, which clicks a route's buttons and links and photographs
the overlays, drawers and destinations behind them, was reachable only by a
project writing `navigation: { enabled: true }` into its config, which is that
project committing to it for every run it will ever have. The toggle is the
other kind of consent: one run at a time, from the person about to press play,
visible before they press it. It carries the accent when it is on, because a
run that clicks the application's own controls is not the same run, and
everything planned gets actuated, destructive controls included. Consent is
stored against the project directory it was given for, so pointing the page at
a second repository starts from no again.

**Fixed with it: a `--first` walk plans the route it is standing on.** The
refresh step was gated to full-scope runs, on the reasoning that a scoped run
cannot see the config's whole intent. `--first` walks the application one route
at a time by synthesizing `--targets`/`--routes` for every stop, so every stop
looked like a caller-narrowed run and no plan was ever drawn up: the play
button, which runs `check --first`, could not have clicked a call to action
even with the config switched on. The walk sees the whole intent one route at a
time and now earns the same entry a full-scope check does. A scoped run that
gets in plans only the routes in its scope, rather than re-planning and
re-capturing the whole application from inside one stop of a walk. `verify-fix`
is scoped and never sets `--first`, so a fix ruling still spends nothing there
and rules on the plan that already exists.
