---
"@nannier-com/lookout": patch
---

A criterion's id is a hash of its text, so rewording a template minted new
ids and every verdict lookout had ruled on the old text reset to pending. A
derived criterion is unique per finding and the universal one per issue, so
when an id misses, the previous criterion with the same origin is the same
question reworded, and its ruling, note, evidence and stamp carry over. Judge
criteria are several per finding and are never carried by origin alone. Two
attributes that fell through to a default template naming the category
token (`dead-control`, and an axe scan whose rule id was not recorded) state
themselves now, and the default names the category in words. The category
vocabulary gains its words (`src/judge/glossary.ts`), held to the category
list by a test.
