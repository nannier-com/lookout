---
"@nannier-com/lookout": patch
---

The shared judging core is named `judge-core` rather than `visual-judge`.

It stopped being the thing that runs when the six specialist panels landed: it
is the skill every panel prompt is composed from, and the old name said
otherwise. The composed prompt bytes are unchanged, so cached judge verdicts
survive the rename.

A skill's name is also the directory a project's own amendments live in, so the
rename would have orphaned every lesson a project had learned about the core,
and every unread proposal, in a directory nothing reads again. A project's layer
is now read from the retired directory when only that exists, and moved to the
current name the next time an amendment is written. Projects carrying a
`.lookout/skills/visual-judge/` layer keep it working with no action needed.
