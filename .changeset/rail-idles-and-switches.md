---
"@nannier-com/lookout": patch
---

The transcript rail goes quiet when the judges do, and empties when you point
lookout somewhere else.

Three defects in the rail, all found by re-reading it rather than by using it,
which is why none of them had shown up:

The rail decided "a judge is speaking" from the last line of whatever frame had
arrived. That line is as likely to be the `close` saying one just stopped, so
the pulsing dot and the judge's name stayed on for as long as the tab was open,
long after the run had finished. It now tracks which calls are open, and says
nothing when none are.

A call that threw never wrote its `close` at all, because `closeCall` sat after
the model call rather than in a `finally`. A failed panel is exactly the one
whose end matters, and it was the one that never ended.

Pointing lookout at another project left the previous project's judges on the
rail. The server decides a page must clear from the file having got shorter,
which catches a new run and a trim but cannot catch a different file: the new
one being longer or shorter says nothing. A switch is now recorded when it
happens, so the next frame carries the clear, including the case where the new
project has never been captured and there is nothing to send but the clear
itself.
