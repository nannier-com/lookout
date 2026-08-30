---
"@nannier-com/lookout": minor
---

Minor justification (new public capability): an issue now carries the fix as
well as the defect. The card links the commit it landed in on the project's own
forge, and shows the frames either side of the fix rather than a strip of
screenshots that quietly became pictures of the fixed screen.

The commit link is string work over `git remote`, memoised per project: GitHub,
GitLab, Bitbucket and Azure get their exact URL shape, an unrecognised forge
gets the near-universal `/commit/<sha>` with its host shown beside it, and a
checkout with no remote shows the sha and says there is nowhere to send you.
"Fixed in" is a verdict lookout reached; "Claimed at" is an attempt still open.

The frames are the part that needed new retention. The evidence store writes
each view back to the path it came from, so `verify-fix` proving a defect gone
also overwrote the only picture of it, and the card kept a strip labelled "where
lookout saw it" that was by then the fixed screen. `verify-fix` now freezes the
defect's frames before it re-captures, once per issue so later attempts still
compare against the defect as filed, and freezes the cleared frames when a
ruling passes. The card pairs them per view under "The fix", and an issue with
no frozen frames stops claiming a settled screenshot is where the defect was.
