---
"@nannier-com/lookout": patch
---

The CLI version under the model menu is found wherever that CLI puts its own
name.

It was read as the leading token, which is right for a CLI that prints
`2.1.263 (Claude Code)` and wrong for one that prints its name first: the whole
line came back, so a panel labelled with the tool would have said the product
name twice. The dotted number is picked out of the line instead, and a version
carrying no such number is still quoted whole rather than dropped.
