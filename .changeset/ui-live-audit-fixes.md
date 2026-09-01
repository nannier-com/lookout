---
"@nannier-com/lookout": patch
---

Three fixes to `lookout ui`, found by auditing the live socket rather than by
anything going wrong.

**A killed run is noticed again.** The page decides a run is abandoned by
comparing the last event's timestamp against the clock, and that comparison used
to be re-run by the poll 40 times a minute. Nothing re-ran it once the socket
replaced the poll, and the case it exists for is exactly the one where no frame
will ever arrive: a check killed outright writes no `run-end`, so the page went
on animating a dead run indefinitely. It is now re-read on the page's own
one-second tick.

**The live socket refuses a handshake from anybody else's page.** A websocket
handshake ignores the same-origin policy and needs no preflight, and this server
greets a new socket with the board and the judge's transcript before the other
end says anything, so any page in any tab could read the project's absolute
path, every issue on it, and the narration. The handshake is now refused unless
the `Origin` matches the address it was made to. The HTTP routes never had this
exposure and are unchanged.

**A re-captured screenshot is no longer served from the browser's cache.** The
thumbnail ETag was base64 of its key truncated to 32 characters, which is the
first 24 bytes of an absolute path: every thumbnail shared one ETag and the
mtime, size, width and fit it exists to distinguish were cut off the end. A
re-capture revalidated as unchanged, so the board kept showing the defect that
had just been fixed. It is hashed now.
