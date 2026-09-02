---
"@nannier-com/lookout": patch
---

**Every deterministic finding has a title, an expected state and an observed
state of its own.** The title used to be the check's message, which leads
with a rule id or a measurement ("heading-order: Heading levels should only
increase by one"), and `expected` and `observed` were empty for every check
but axe. Each type now names the defect as a person would recognise it ("The
page logged an error: TypeError: x is undefined", "Content runs 42px off the
side of the screen (.card__title)", "\"Menu\" did nothing when clicked",
and axe's own help sentence without the rule id in front), states the fixed
condition, and records what this capture showed with the detail the check
kept (the error's file and line and how often it fired, the request's method,
the overflow's path). A grouped issue's title names its category in words:
"4 accessibility problems on /users", not "4 a11y defects". The five checks
that describe lookout's own capture rather than the application (a blank
shot, a state that could not be reached, identical light and dark captures,
a frame still rendering, a capture that landed elsewhere) say so first and
trail "What lookout recorded" rather than "What the check measured". axe's
impact sentence names the severity lookout files the finding under. Existing
findings pick all of this up the next time their view is captured.
