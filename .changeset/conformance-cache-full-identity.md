---
"@nannier-com/lookout": patch
---

The conformance cache's identity now covers the composed skill text and the
model, not just the skill version and kit exports. A project amendment with
no version field changes the prompt, and a `--model` flip changes whose
verdict it is; both previously left every cached verdict standing, and both
now discard the cache whole, which is the same bargain the judge ledger
already makes.
