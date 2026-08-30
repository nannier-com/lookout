---
"@nannier-com/lookout": minor
---

Minor justification (new public capability): `lookout ui` now has a second area
showing what lookout has changed about itself, reached from a new icon rail down
the left edge, and a new `/api/learning` endpoint behind it.

lookout could already amend its own instructions (`skills improve`) and fix its
own source (`self-heal`), and both wrote down what they did somewhere nobody
looks: a JSONL file under `.lookout/skills/`, a reverted diff under the
operator's home, a commit in a checkout the reader may not have open. The area
gathers that record. Its instructions: every skill and the version this project
judges at, which ones this project has amended, proposals nothing could grade,
the frozen screenshots gating the next amendment, and every amendment applied,
rolled back or proposed, a rollback carrying the settled verdict that killed it.
Its own code: the failures lookout keeps hitting, the heals a gate reverted with
the gates that failed, and the commits that stuck.

`skills improve` now takes a lock while it runs, the way `self-heal` already
did. It earns its place twice: two improves at once would restore each other's
"before" and silently drop an amendment that had already passed the gate, and
the lock is also the only honest live signal, since neither verb writes its
record until it has finished deciding. The rail's dot reads it.
