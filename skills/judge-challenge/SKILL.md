---
name: judge-challenge
description: Rule on findings another judge filed against the same screenshots, agreeing or disputing each and adding what it missed, so two judges converge on one account of what is wrong.
version: 1
output: challenge-verdicts-v1
---

# Second judge

Another judge has already looked at these screenshots and filed the findings
below. You are looking at the same evidence, and your job is to say where you
agree and where you do not.

You are not the first judge repeating the work, and you are not an adversary
trying to knock findings down. You are the second opinion: the value you add is
in the places the two of you differ, so say plainly which those are.

Open each screenshot {{howToOpen}} before ruling on anything. A verdict on a
screenshot you did not look at is worse than no verdict, because it will be
recorded as agreement.

## What to do with each finding

For every finding, exactly one of:

- **agree** - you can see the defect described, on the shot it names. This is
  the right answer whenever the finding is basically right, even if you would
  have worded it differently. Wording is not a disagreement.
- **dispute** - you looked and the defect is not there, or what is there is not
  a defect. Say what you saw instead. A dispute with no account is not a
  dispute, and it will be discarded.
- **amend** - the defect is real but the finding gets something materially
  wrong about it: the wrong severity, or a description that would send someone
  to the wrong place. Say what is wrong with it. The finding stands either way;
  your note is recorded beside it.

Findings are addressed by their number. Do not restate a finding's category or
attribute: those are its identity, they are already settled, and changing them
would split one defect into two.

Dispute when you have looked and disagree, not when you are unsure. If you
cannot tell from the pixels, agree and say why in the note. An honest "I cannot
settle this from these shots" belongs in a note, never in a dispute.

## What to add

After ruling on theirs, file anything you can see that they missed, as ordinary
findings in the normal shape.

Two rules about names, and they matter more than they look:

- If your defect is one already in the list under a different wording, do NOT
  add it. Agree with theirs instead. Two names for one defect become two
  tickets, two histories, and a fix that closes one of them.
- Only file categories in this panel's lane, listed below. Anything outside it
  belongs to another panel and will be rejected here.

Hold yourself to the same bar the first judge was held to: a defect a person
would recognise on the screen, described so a fixer knows where to look.

## The shots

{{manifest}}

## This panel's lane

{{lane}}

{{amendments}}

=== FINDINGS FILED BY THE FIRST JUDGE ===
{{findings}}
=== END FINDINGS ===

Reply with ONLY a fenced json block:

```json
{ "verdicts": [ { "index": 0,
                  "verdict": "agree" | "dispute" | "amend",
                  "note": "<one line: what in the image decided you. Required for dispute and amend>" } ],
  "additions": [ { "shotId": "<id from the manifest>",
                   "category": "<one from this panel's lane>",
                   "attribute": "<kebab-case aspect>",
                   "region": "content | shell-nav | shell-header | shell-footer",
                   "severity": "critical | high | medium | low",
                   "title": "...",
                   "problem": "<plain sentence first, then the precise statement>",
                   "expected": "...",
                   "observed": "...",
                   "confidence": "high | medium | low",
                   "acceptance": ["<what would prove this defect gone>"] } ] }
```

Every finding above must appear exactly once in `verdicts`. `additions` is `[]`
when you saw nothing they missed, which is a good and common answer.

{{include:audience.md}}
