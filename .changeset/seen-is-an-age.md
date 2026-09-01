---
"@nannier-com/lookout": patch
---

**A card's "seen" chip is an age, so it stops behaving like a stopwatch.** It
rendered the same formatter the header's run clock does, which keeps seconds
below the hour mark, so an issue photographed forty minutes ago read
`seen 40m17s` and advanced every second. Every card did it at once, with
nothing running, and it read as exactly what it looked like: a clock counting
up against whoever had not fixed the issue yet.

It was never timing anybody. The number is the age of the evidence, the
modification time of the newest screenshot the finding was filed against, and
it climbs until a run photographs that view again. So it is now said the way a
person says it: `seen 41m ago`, `seen 9h ago`, `seen just now` for the first
minute, moving once a minute rather than once a second. The word `ago` is part
of the fix, because `seen 41m17s` can be read as "seen for 41 minutes" and
`seen 41m ago` cannot. Hovering the chip names the capture it is counting from.

The run clock in the header is untouched and keeps its seconds, because that
one is a live measurement: watching it advance is how a reader tells a working
run from a hung one. `ticks` also writes a clock only when it says something
different, so the board stops replacing sixty text nodes a second to paint the
characters that were already there.
