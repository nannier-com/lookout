---
"@nannier-com/lookout": minor
---

The judge's column folds away.

New capability: a control in the transcript's header that folds it down to a
strip the width of the rail on the other side of the page, and unfolds it
again. The choice is remembered per browser, so the page comes back the shape
it was left in.

The transcript is a fixed column rather than a drawer on purpose: the question
it answers ("is this thing still working?") is one you have while looking at
something else, and a drawer you have to go and open answers it too late. What
that costs is 340px of board, held whether or not anything is being judged, and
on a laptop that is a column of cards. Folding hands the width back without
giving up the answer: the strip keeps the live dot, so a judge that starts
talking still says so.

Shut, the page has the same furniture at both edges: icons on the left, a way
back into the transcript on the right. `tools/ui-check` captures the folded
state as its own view and drives the control through folding, reloading and
unfolding, so both shapes are gated the way every other region is.
