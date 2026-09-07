---
"@nannier-com/lookout": minor
---

Codex can judge, and its model is chosen from what the installed CLI offers.

New user-visible capability: the settings panel now carries a Codex model row
beside the Claude Code one, each a menu built from the models that install
actually offers, each with that CLI's version beneath it. Codex is a judge
lookout can ask rather than only a tool it can hand an issue to.

Two filters decide the Codex menu, and both are the CLI's own answers rather
than lookout's: `visibility`, which is that CLI's judgement about what a picker
should show, and whether the model accepts an image at all. This install lists
a text-only model among its visible ones, and a model that cannot see a
screenshot has no business in a menu of judges.

Codex is found even when it is not on PATH. It installs itself where its own
plugin manager chooses, so lookout looks at an environment override first, then
PATH, then the locations that manager uses. A moved path is data rather than a
bug, and `LOOKOUT_CODEX_BIN` names an install nobody predicted.

Four things about that CLI were established by running it rather than by
reading about it, and each is load-bearing: it hangs waiting for end of input
unless its stdin is closed; `exec` refuses to run outside a git repository, and
the judge runs in a scratch directory on purpose; its final message can be
written to a file, so a verdict never depends on parsing an event stream; and
its stream does not report opening an image. That last one means lookout cannot
run its clean-without-looking check against Codex, so the adapter says so rather
than concluding every shot went unread.

Judging still runs on one AI. This release is the adapter, the discovery and the
settings row; the dialogue between two judges follows.
