---
"@nannier-com/lookout": patch
---

The issue document's sections each live in their own module beside the
assembly (`src/issues/doc-defects.ts`, `doc-evidence.ts`, `doc-verify.ts`),
reading from one `IssueContext` that the JSON record (`src/issues/record.ts`)
shares. The attempt record and the judge's one-sentence account are written by
one module for both channels (`src/verify/attempt.ts`), the axe scan has its
own (`src/capture/axe.ts`), and the device scale factor lives beside the
viewport table so a document can state a screenshot's geometry without loading
the browser. No output changes: every Issue.md and Issue.json regenerated from
the ui-check fixture is byte-identical before and after.
