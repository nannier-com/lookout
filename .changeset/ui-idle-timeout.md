---
"@nannier-com/lookout": patch
---

`lookout ui` no longer times out the folder picker, and drops a heartbeat that
was doing nothing.

bun has two `idleTimeout` options: the one on the `websocket` handler governs a
socket, and the one at the top level is the HTTP inactivity timeout. The value
was set at the top level believing it governed the socket. It did not. What it
did govern was every HTTP request, and that turns out to matter: `POST
/api/pick` opens a native folder picker and does not answer until somebody has
chosen a directory, while bun's default closes a quiet connection after ten
seconds. The option now carries the maximum bun accepts, named for the reason
that is real, so choosing a project from the page cannot fail for anyone who
browses rather than types.

The server's own thirty-second ping is removed. bun's `sendPings` defaults to
true, so it already pings and answers pings; a socket with no ping of lookout's
stays open indefinitely.
