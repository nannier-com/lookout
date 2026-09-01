---
"@nannier-com/lookout": patch
---

The design-placement judge starts from observed facts: its prompt now carries
a "What was rendering there" block built from the defect's provenance
sidecars (component chains and source files seen on the running page, hash
drift annotated), with instructions to open every named file before trusting
it and to fall back to searching when the block is empty. Skill version 2; no
ledger or replay consequences, since design-placement sits outside every
panel identity and is deliberately ungated.
