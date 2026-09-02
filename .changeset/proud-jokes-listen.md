---
"@nannier-com/lookout": patch
---

**lookout keeps nothing in a home directory of its own.** `LOOKOUT_HOME` is
gone, `~/.lookout` is never read or written, and `src/home.ts` is deleted.
Everything lookout writes about a project is in that project's gitignored
`.lookout/`, and everything it writes about itself is in its own checkout's.
The one file that travels with a repository is `lookout.config.ts` at its root.

`lookout doctor` reports a leftover `~/.lookout` when it finds one and says it
is safe to delete; nothing deletes it, and nothing migrates out of it. A run
that still has `LOOKOUT_HOME` exported prints one line saying the variable is
no longer read, so an operator is told rather than left wondering where their
state went.
