---
"@nannier-com/lookout": patch
---

The judge is now shown the two things lookout already knew and kept from it.

**Deterministic signals.** Every shot carries the results of the checks that run
before judging: the accessibility rule that fired, the element measured
overflowing its container and by how much, the errors the page logged. None of
it reached the judge prompt. Each shot in the manifest now carries a compact
`signals:` line, capped at the first few, with the rubric telling the judge what
they are for: they are the one part of this pipeline that is a real measurement,
so they localize and corroborate, but they are not to be restated as findings
(lookout has already filed them) and their absence is not evidence a view is
clean. This is precise information a model cannot produce for itself, computed
already, previously discarded.

**Findings already open on the view.** The `attribute` on a finding is free text
the judge writes, and it is half of both the fingerprint and the cluster key. The
same defect coming back as `dark-theme-stuck` instead of `theme-not-switching`
therefore minted a second issue, split the attempt history across two, and made
the first look like it had drifted away. The prompt now lists what lookout has
open on the views in the batch and asks the judge to reuse the category and
attribute when it files the same defect again. Absence still reports a fix: the
list is explicitly not a claim that those defects are still there.
