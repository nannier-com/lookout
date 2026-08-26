---
"@nannier-com/lookout": minor
---

Open an issue in Claude Code or Codex, from the card.

Every issue card has a launch button, and the navbar carries a toggle choosing
which tool it opens: Claude Code or Codex, remembered per browser so nobody
re-picks it every visit. A tool whose binary is not on PATH is shown greyed
rather than hidden, and choosing it still works: the handoff is written and the
exact command handed back to run by hand, because a button that silently does
nothing is worse than one that tells you why.

Clicking writes a handoff document gathering everything scattered across the
backlog, the evidence directory and the state file into one file: what is wrong
in the judge's own words, expected against observed, every screenshot by
absolute path, the contact sheet, the repository, and how to ask lookout to rule
when the change is made. On macOS it then opens that document in the chosen tool
in a new terminal.

This is not lookout dispatching work again, and the document is written so it
cannot read as such: it names no subagent, sets no protocol, and asks for
nothing back. It runs because a person clicked, and it says so in the text. The
one instruction it carries is the only one lookout is entitled to give, which is
not to take your own word for whether the defect is gone.
