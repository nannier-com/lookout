---
"@nannier-com/lookout": patch
---

Split `src/design/conformance.ts` into the three jobs it was already doing, and
drop it from the debt list in `eslint.config.mjs`: choosing which files are
worth a model's attention (`conformance-candidates`), putting one batch to the
model and refusing to believe the reply (`conformance-batch`), and running the
sweep around both. Behaviour is unchanged, verified by running
`lookout design-system --audit` fresh and cached against a fixture project.
