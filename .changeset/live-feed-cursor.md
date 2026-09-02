---
"@nannier-com/lookout": patch
---

The live feed's cursor on a card being re-judged is a block again. The
stylesheet spelled it `"█"`, which is not a CSS escape (CSS wants
`"\2588"`), so the backslash escaped the `u` and the page drew the letters
`u2588` after the last line. The ui gate had never captured a card mid-verify,
so nothing saw it until the fixture gained one.
