---
"@nannier-com/lookout": patch
---

**One defect stops being minted under two or three names.** The `attribute` is
free text a judge writes, and it is half of both a finding's fingerprint and
its issue cluster key, so the same defect arriving under a different word mints
a second issue, splits the attempt history, and makes the first look resolved.
The list of names lookout already had was built once per run, from open
findings only, which left two gaps.

Names a person settled now travel too, marked `(settled)` and explained as
names rather than defects to hunt for. That closes the case that taught the
lesson: once a colour-scheme defect was ruled by-design, the next run stopped
seeing its name, re-filed it under a fresh attribute, and minted a second issue
the ruling could not reach, because merge suppresses an exact fingerprint and
cannot suppress a synonym.

And what a run has already filed travels within that run. Each view group's
confirmed findings become names later groups can reuse, capped like the
existing list, refuted names excluded so a group is never invited to file what
the verifier just killed. Groups judged concurrently are still blind to each
other, so the first two anchor independently; every later group sees whichever
finished first.
