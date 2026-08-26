---
"@nannier-com/lookout": minor
---

Run a check from the page, and tell whoever opens an issue what the rules are.

A **Find and fix** button sits under the tool toggle. It runs one check against
the project the page is pointed at, stopping at the first issue: the loop it
serves is find one, fix one, verify it, and judging on for another eight minutes
to hand back twenty-six more answers a question nobody has asked yet. `lookout
check --first` does the same from a terminal, and `--limit <n>` stops after n.
A run that stopped early says so, in the log and on the page, because "1
finding" would otherwise read as a clean bill of health for an application that
was mostly never looked at.

The button knows when it cannot work. With no `.lookout/config.ts` where the
page is pointed, it reads **Choose a repo** and opens a native folder picker
first; a browser cannot hand back a real filesystem path, so the local server
asks the operating system instead. `lookout ui` is therefore no longer bound for
life to the directory it was launched in: point it at another repository and it
serves that one, board and all.

Handoffs now name the rules that govern the work, global first, then the
workspace's, then the repository's, each by absolute path, and say to read them
before editing anything. Claude Code loads its own global file; nothing else
does, and the whole point of the tool toggle is that a handoff may not be opened
in Claude Code. Discovery covers `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and
the equivalents for the other harnesses.
