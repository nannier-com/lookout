---
"@nannier-com/lookout": minor
---

A check can now be judged by two AIs.

New user-visible capability: `lookout check --challenger codex:gpt-6-astra` has
a second AI rule on what the first one filed against the same screenshots. It
agrees or disputes each finding and adds anything it missed, and the finding
carries both accounts into the backlog.

The flag names an AI and a model together, and is refused rather than ignored
when either is missing or unusable: a flag somebody typed and lookout silently
dropped is how a run comes to cost one judge's money while its operator believes
two were watching. An AI cannot challenge itself, because a second opinion from
the same AI on the same evidence is the refuter, which already runs.

A verdict two judges reached is not a verdict one reached, so the judging roster
now enters the ledger's prompt hash. Two consequences worth knowing. The first
check after upgrading re-judges rather than serving cached verdicts, once.
And the roster is hashed sorted, so which AI proposed can change between runs
without turning every run into a cache miss.

A batch whose second judge could not be reached is kept but not cached. The
proposal is real and stands; caching it would durably record a dialogue that
never happened under an identity claiming two judges agreed. This is deliberately
the opposite of how a failed refutation is treated: a refuter can only annotate,
so its absence is a missing note that a later pass repairs, while a challenger
can add findings, so its absence is a missing verdict.
