---
"@nannier-com/lookout": patch
---

Rename the directory holding the frames either side of a fix from
`evidence/frozen/<id>/` to `evidence/fix-frames/<id>/`. `lookout skills freeze`
already keeps a frozen regression set, and two unrelated things wearing one word
is how somebody deletes the wrong directory. Nothing carries over: the frames
are gitignored evidence, and an issue with none simply shows the strip it always
showed.

Document what a fixed issue keeps, in all three places somebody looks: the
README, the contract `lookout protocol` prints, and the skill an agent reads
before driving it.
