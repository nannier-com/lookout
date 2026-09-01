---
"@nannier-com/lookout": minor
---

The page shows what the judge is saying, as it says it.

New capability: a transcript rail down the right of `lookout ui`, streaming the
model's own output live. Every tool call it makes ("Read
web/app/dashboard/rest/desktop/dark") and every word of the verdict it writes
appear as they happen, under the name of the judge saying them.

Judging is the part of a run that takes the time and it was the part with
nothing to look at. Pressing play captured six screenshots in nine seconds and
then went quiet for eight minutes per view group while five judges read them in
turn, which is indistinguishable from a run that has died. The rail is the
answer to "is this thing still working", asked while looking at something else,
which is why it is a column that is always there rather than a panel to go and
open. It hides below 900px, where a board has no room for a second column.

The stream arrives on the socket the page already holds open, as its own kind
of frame: the board is sent whole because it is small and changes rarely, while
narration is sent as a delta because a judge mid-verdict speaks several times a
second. A page that arrives in the middle of a run is handed the transcript so
far rather than only what happens next, and one whose socket never opens falls
back to `/api/narration`.
