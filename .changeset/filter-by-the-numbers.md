---
"@nannier-com/lookout": minor
---

Click a headline number to see the work it counts.

The numbers across the top of `lookout ui` were the fastest way to find out
there were seventeen clusters awaiting a session, and no way at all to see
which seventeen. They are buttons now. Clicking "awaiting a session", "working",
"reported back" or "settled" narrows the board to those fix sessions; clicking
"critical", "high", "medium" or "low" narrows to that severity. Both sections
narrow together, so they always describe the same slice of work: under a state
filter the findings shown are the ones belonging to the sessions on screen.

The click scrolls to the section it just narrowed and flashes it, the active
tile is marked, a bar names what is being shown, and clicking the same tile
again, pressing the bar's button, or hitting Escape puts everything back. A
number that stands for nothing is not a control, so "shots" and "batches" stay
inert, and a count of zero is disabled rather than offering an empty view.

Making them filters exposed that they were counting the wrong thing. The
findings section and its severity numbers were still built from `finding`
events, so they had the bug the board was just fixed for: the log is truncated
by every capture, and a project with fifty-three outstanding findings displayed
two. Findings now come from the backlog, the same durable source as the board,
which is also why they can name the cluster that owns them: each one carries its
cluster id, so a finding card links to the session working it rather than
leaving you to pair a category and a route by eye. Blocked findings are shown
and marked as such instead of being silently dropped.
