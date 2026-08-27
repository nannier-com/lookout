---
"@nannier-com/lookout": minor
---

lookout fixes the cause of its own recurring failures, in its own source, and is
not believed about any of it.

New user-visible capability: `lookout self-heal`. Failures now land in
`~/.lookout/incidents.jsonl`, pooled across every project on the machine and
never truncated: crashes and operator errors from the CLI's top-level handler,
judge replies that could not be parsed, and findings rejected at ingestion
because the reply broke the output contract. `events.jsonl` could never serve
this, since every capture truncates it and the failure is gone by the time
anybody could act on it.

`self-heal` groups the incidents by shape, hands one group to the new
`self-heal` skill, and gates everything that comes back. The subprocess may read
and edit inside lookout's own checkout and may not run a single command, so
whether the change is good is never its own report: lookout runs `tsc --noEmit`,
`eslint`, `bun test` and the build itself, and replays a project's frozen
regression set when `--project` names one. Any gate failing reverts the whole
change, keeps the diff and the gate output under `~/.lookout/self-heal/<stamp>/`
for a person to read, and records the rollback as an incident of its own. Every
gate passing commits the change alone with a patch changeset, and does not push,
because a local commit is one `git revert` away and a push is somebody else's
problem to undo.

It refuses an installed package, since there is no source to fix and no
repository to revert in; a checkout with uncommitted work, since reverting would
take that with it; and a second run while another holds the lock.

`invokeClaude` gained an `allowedTools` option for this. Every judging path
still runs read-only, which is the point: an oracle that can edit is not an
oracle.
