---
"@nannier-com/lookout": patch
---

**Every prose field names its reader, and the refuter supplies the plain
sentence a judge left out.** The judge's contract now says what `title` is
for (printed on its own: what is wrong and where, no rule ids or tokens),
that `observed` is quoted back to a person as lookout's verdict, and that a
criterion has to be readable on its own beside being decidable. The
acceptance verifier's `reasoning`, the placement advisor's `reason` and
`blastRadius`, and the navigation planner's `why` say the same. The six
judge panels share one file for their pointer to the audience rule instead
of six pasted copies. Versions are bumped, so every cached verdict is
re-judged under the new wording.

The adversarial verifier's contract becomes `refute-verdicts-v2`: when it
confirms a finding whose problem does not open with a sentence a person can
follow, it may supply that sentence in `plain`, and lookout puts it above the
judge's text (never in place of it), only when the judge's text needed one
and only when the sentence passes the same bar (`src/backlog/prose.ts`, the
one definition of "written for both readers"). Each such repair is reported
with the panel that skipped the sentence, so the panel can be taught.
