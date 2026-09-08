---
"@nannier-com/lookout": minor
---

Two judges can reach one account of what is wrong.

New user-visible capability: a second AI can be asked to rule on what the first
one filed against the same screenshots, agreeing or disputing each finding and
adding what it missed. A finding then carries both accounts. This release is the
dialogue and its instruction file; the run does not yet start one, which is the
next change.

The decision the rest follows from: **the second judge answers by number.** It
is handed the findings numbered and rules on each positionally, and it never
restates a finding's category or attribute. Those two fields are half of a
finding's fingerprint and half of the cluster key that mints its issue id, and
they are the only ones a model writes freehand: a challenger allowed to reword
them would turn one defect into two the moment it agreed in different words.
Answering positionally, it cannot diverge on an identity it never writes. Only
its own additions carry free text, and those go through the ordinary judge
ingestion with the same lane, the same vocabularies and the same caps.

Disagreement is kept, not applied. A disputed finding is still filed and still
open, and a dispute changes no status and no severity; both accounts are on the
record and a person decides. Letting one AI close or downgrade another's
finding would hand a single vendor a veto over the backlog.

Nothing the second judge says is trusted. An unrecognised verdict word, a number
pointing at no finding, a second verdict for one finding, or a dispute with no
reasons is treated as absent, leaving the first judge's finding standing. Never
as a dispute: a mangled reply must not be able to cast doubt on work somebody
has to act on.

A challenge that fails is not fatal and not silent. The proposal stands alone
and the batch is reported as undialogued, so it can be left out of the cache
rather than durably recording a dialogue that never happened.

The skill is written for whichever AI reads it, and the second judge speaks in
its own voice in the transcript, so two AIs working one panel can be told apart.
