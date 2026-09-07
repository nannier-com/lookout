---
"@nannier-com/lookout": patch
---

A backlog nobody can read takes one request down, not the whole server.

`lookout ui` exited on a `.lookout/backlog.json` that was valid JSON without a
`findings` key. `reconcileIssues` defaults `backlog.issues` to `{}` and then
iterates `backlog.findings` on the next line without defaulting it, so the load
threw a `TypeError` from three frames below anything that could name the file
it came from. The `/api/status` route already caught that and answered 500 with
the reason on it, which was the right intent and half the paths: the same board
build is reached from the watcher's timer and from the server's own start, both
through a bare `void pumpQueue(...)`, and there a rejection is an unhandled one
and the process goes. A watcher is the first thing to see a bad file appear, so
the usual way to meet this was a `lookout ui` that had been up for hours dying
the moment something wrote a half-formed backlog underneath it. Starting one
against a project already in that state died before the first request.

Both halves are fixed, because neither covers for the other.

`loadBacklog` now imposes the shape the `Backlog` type promises on whatever was
actually parsed: `findings` and `issues` that are missing, null, or the wrong
kind of container each become an empty record. That is the one place the file
becomes a `Backlog`, and it is the only place that can say which file was
wrong; the dozen call sites below it that iterate those two keys had all taken
them on faith. An array is coerced rather than passed through even though
`Object.values` would survive one, because an id minted onto an array is a
string key and `JSON.stringify` drops those, which is precisely the forgotten
id that reconciling on load exists to prevent. Findings themselves are left
alone: a malformed one is `backlog check`'s report to make, by fingerprint, and
dropping it here would hide a defect somebody is still owed.

`pumpQueue` now holds to the property its own header claims. The catch inside
`advanceQueue` was already there and said as much, but the board build sits in
the argument list outside it, and building the board is itself a read of the
backlog.

A backlog nobody can PARSE still throws, deliberately. Reading a corrupt record
as empty would show a project whose every finding had been ruled gone, and the
next save would make that true. It reaches the page the way it always should
have: `/api/status` answers 500 with the parse error, the board recovers on the
next write once the file is repaired, and no restart is needed.
