---
"@nannier-com/lookout": patch
---

A finding can record what the judging AIs said about it.

Groundwork for two AIs judging together: a finding may now carry which AI filed
it, which agreed, and which disputed it with its reasons. Nothing writes it yet;
this release is the shape, its validation and the rules that keep it honest.

Three of those rules are worth stating, because each is a way the feature could
have gone wrong:

It is never part of a finding's identity. Two AIs agreeing about one defect must
produce one row in the backlog, and an identity that carried who spoke would
split it the moment the second agreed. A test pins the fingerprint and the
cluster key as byte-identical with and without a dialogue.

A dispute is not a status. `FindingStatus` stays closed at its four values and
"disputed" is derived when a card is drawn, because an objection is a caveat on
open work rather than an adjudication. Letting one AI's disagreement close
another's finding would hand a single vendor a veto.

The record is refreshed by a run that held a dialogue and never cleared by one
that did not. A run whose challenge call failed carries no verdict, and silence
must not erase the dispute the last run recorded, for the same reason a run with
the refuter switched off does not erase its note.

No backlog schema bump: every field is optional and absent-tolerant, no record
is rewritten, and no fingerprint moves. Absence reads as unknown rather than as
whichever AI happens to be configured, so an old finding is never stamped with a
verdict it never got.
