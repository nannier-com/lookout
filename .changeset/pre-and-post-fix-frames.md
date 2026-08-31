---
"@nannier-com/lookout": minor
---

Every issue now keeps a pre-fix screenshot, and the card shows the pre and post
fix pair instead of a strip of the store's current copies.

The new capability is the guarantee: an issue is frozen by the save that files
it, so a picture of the defect exists from the moment lookout finds it rather
than from the moment somebody first asks it to verify a fix. Before this, only
`verify-fix` froze anything, so an issue nobody ever asked lookout to rule on had
no picture of itself anywhere. The evidence store keeps one file per view and
overwrites it on every capture, which meant the card's "Where lookout saw it"
strip became a picture of whatever replaced the defect at the next run, under a
heading claiming otherwise.

What changed, in the places you will notice:

- The card's evidence section is now "Pre and post fix": one pair per view,
  frozen frames on both sides, with the missing half saying which case it is
  ("no post-fix frame yet" on live work, "no post-fix frame kept" on a settled
  issue nothing could copy). The pairs wrap rather than scrolling sideways, so a
  second pair is never hidden off the edge of the card. "On disk" lists the
  frozen frames, because those are the paths that stay put.
- The issue folder's `img/` is a copy of the frozen frames, in `img/pre/` and
  `img/post/`. It used to re-copy from the store whenever the store was newer,
  so the folder documented as "the screenshots it was filed against" quietly
  became the fixed screen. Existing folders migrate: the old flat pile moves into
  `img/pre/`, since those are the older picture. `Issue.md` points at the frozen
  frames too.
- `lookout backlog check` reports an issue with a screenshot behind it and no
  pre-fix frame, so the guarantee is checked rather than assumed.

An issue that has already spent a fix attempt is never backfilled: something has
claimed to change that screen since it was filed, so its store frames are of
unknown vintage, and filing them as the defect would be a picture of somebody's
fix under the wrong label. `verify-fix` follows the same rule now instead of
freezing whatever it happens to find.
