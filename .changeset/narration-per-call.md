---
"@nannier-com/lookout": patch
---

Two judges talking at once no longer shred each other's verdicts.

A check runs two workers over view groups and both walk their panels in the
same order, so at almost every moment two calls to the SAME judge are in flight
against different views. The transcript gathered prose by judge NAME, so those
two streams went into one buffer: reassembled, a single `judge-integrity`
heading carried two JSON replies spliced together, with nothing to say which
view either half belonged to. Measured on a two-route run, every one of the ten
panel calls came out spliced.

Narration is now gathered per call rather than per name, and every line carries
the id of the call that wrote it. The rail grows each call's paragraph in its
own block instead of appending to whichever block came last, and a call's
heading names the view it is judging (`judge-integrity app/dashboard · 6
shot(s)`) so two blocks under the same judge can be told apart. The same
two-route run now produces ten calls, each with its verdict intact.

`tools/ui-check`'s fixture seeds two interleaved calls of one judge, so the
visual gate covers the case rather than only the tidy one.
