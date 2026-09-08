---
"@nannier-com/lookout": patch
---

The tool toggle shows which tool is selected, and its marks actually paint.

Two defects, one control. The marks lookout draws for Claude Code and Codex
carried no `xmlns`, and the page shows a mark through an `<img>`, which parses
it as a standalone document with no HTML parser to imply the SVG namespace: both
failed to load, silently, leaving two 16px holes. And the selected tool was
drawn as a ghost button while the unselected one was outlined, so turning a tool
on took its border away. With both on, the picker was two words of plain text.

A selected tool is now the filled one and an unselected tool is bare, at the
same height either way, so pressing one no longer moves the row. A mark that
asks for `currentColor` is resolved against the live theme before it is encoded,
because an `<img>` has nothing to inherit from and would otherwise paint the
Codex mark black on a dark page.
