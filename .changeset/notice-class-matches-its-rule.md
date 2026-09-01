---
"@nannier-com/lookout": patch
---

ui: header notices render in the notice style again. paintWhere() toggled a
class literally named "page.notice", which no stylesheet rule matches, so every
notice (a failed run's stderr, a missing config, a pick error) rendered as a
quiet rtl-ellipsized path in the path colour. The toggled class is now
"notice", matching .where.notice in shell.css: red, ltr, wrapped in full.
