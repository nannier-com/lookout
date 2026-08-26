---
"@nannier-com/lookout": minor
---

lookout finds issues and documents them. It no longer dispatches work.

It used to render every root cause as an executable prompt and tell the calling
session to spawn a named subagent on it, then track those sessions as they
worked. That was lookout deciding who does what, which is not its job. All of it
is gone: `check --auto`, the dispatch streamer, the fix briefs, `PLAN.json`,
`backlog plan`, the spawn instructions in the protocol, and the `lookout agent`
verb that tracked the sessions.

What lookout does now is state plainly in `lookout protocol`: it captures what
an application renders, judges the pixels, writes down what is wrong, and rules
on whether a defect is gone when you ask it to. What to do about a finding is
your call.

`verify-fix` stays, because verifying is not fixing. It remains the only thing
that closes a finding, and the only thing that can say a defect is actually
gone, which is the oracle property the whole design rests on.

`lookout ui` is rebuilt around that. It shows **issues**, not fix sessions: one
issue is one root cause, carrying its severity, the routes it appears on, the
screenshots it was filed against, a contact sheet showing them together, and
lookout's own record of it, oldest first, from the day it was filed through
every ruling. While a `verify-fix` is running, that record tails live, the way
a log does.

Every path on the page is absolute, because the point of the page is handing an
issue to somebody who then has to go and open those files. Each card ends with
an "Evidence on disk" block listing its contact sheet and screenshots in full,
selectable form, and `lookout status` prints them the same way.

The filters moved into the navbar, where they read as navigation rather than as
statistics: open, blocked, done and archived narrow the issues, the four
severities narrow the findings, and a clear control appears beside them while a
filter is on.
