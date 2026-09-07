---
"@nannier-com/lookout": minor
---

Two clear buttons in the page: one empties the judge's transcript, one deletes
everything lookout found here.

The page had no way to throw anything away. A finished run's transcript stayed
in the judge's column with only a fold button to hide it, and nothing anywhere
reset a project: no verb, no route. Starting clean meant deleting `.lookout/` by
hand, which does not work, and the way it fails is the reason both of these are
server-side rather than a wipe of the page.

What the page shows is assembled from three stores. The files under the
project's `.lookout/`; the server's caches over them, the status body and the
narration cursor, neither of which re-reads a file it has already answered from;
and the server's own memory, which for the queue is not a cache at all, since
`session.queue` is the authority and `queue.json` is only its sidecar. Deleting
the directory reaches one of the three, which is why a page whose record was
removed by hand goes on reporting the shot count and duration of a run whose
files are gone.

So the reset reaches all three. It deletes the record entry by entry rather than
removing the directory, which keeps `ui.json` with no window where the settings
exist only in this process: wiping the record and being asked to choose the
folder again are two acts, and only one of them is this. It is refused with a
409 while a run is in flight, matching stop, since deleting the workspace
underneath a capture would race the writer.

Clearing the transcript truncates the narration file rather than unlinking it,
because a run in flight holds that path and goes on appending, and it resets the
cursor, without which every open page would keep showing what was cleared.

Both ask first, through one prompt that names what it costs rather than asking
whether you are sure: the issue folders and their frozen before and after
screenshots are not in git, and no undo reaches them. Focus lands on Cancel, and
Escape and the scrim both answer no. The transcript's clear sits at the end of
the judge's header; the wipe sits in the settings panel, ruled off below the
rows that only change where lookout looks.

New routes `/api/narration/clear` and `/api/reset`, both POST, both pushed to
every open tab.
