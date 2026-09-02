---
"@nannier-com/lookout": patch
---

**A ruling is measured against the issue's own record, not the workspace.**
This changes the verdict rule's input. The pixels-moved guard (nothing passes
on unchanged pixels) compared fresh screenshots to whatever the capture
workspace held, and the workspace moves with every capture: a `lookout check`
of the routes between the edit and the ruling put the fixed page in it, the
ruling compared the fixed page to itself, and a real fix was ruled "nothing
changed" and spent an attempt. The README recommended that very loop.

Each shot is now compared, in this order, to the capture of the previous
ruling (recorded in `state.json` as the ruling's baseline, by shot and hash),
then to the frame frozen when the issue was filed (frames now record the shot
they copy and the hash of its pixels; frames frozen earlier recover both from
the file and the view), and only for shots the issue has no record of, such
as the routes a shell verify tops up with, to the workspace and the backlog's
evidence as before. A `check` or `capture` between the edit and the ruling no
longer moves the baseline. The attempt record, the stdout account and the
document each say which of the three the ruling compared against.
