---
"@nannier-com/lookout": minor
---

The capture workspace moves out of the judged project, and every issue folder becomes self-contained.

Shots, the capture report, the run log and contact sheets now live in one workspace per project under LOOKOUT_HOME (default `~/.lookout/evidence/<project>-<pathhash>/`), keyed by the project's real path so separate checkouts stay separate. A judged project's `.lookout/` now holds only the durable record: the backlog, the ledger, the skill amendments, and issue folders that carry their own frozen pixels (`img/pre`, `img/post`, `frames.json`). The user-visible capability: an issue dossier is complete in itself, so it can be zipped, diffed or handed to an agent whole, and cleaning the workspace can never cost a project the picture of a defect.

Frames an older lookout froze under `.lookout/evidence/fix-frames/` are adopted into the issue folder the first time they are read. The rest of an old `.lookout/evidence/` directory is never written again and is safe to delete; the next capture rebuilds its report in the new workspace.
