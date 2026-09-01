---
name: improve-skills
description: Read what lookout got wrong in its own runs and write the amendment to the skill that would have prevented it.
version: 3
output: skill-amendment-v1
---

# Amending lookout's own instructions

You are improving one of lookout's skills for the project "{{project}}".

Below are signals from this project's own runs: findings the adversarial
verifier refuted, findings a person adjudicated as intentional and wrote a
reason for, defects that survived every fix attempt, acceptance criteria that
could not be decided from a screenshot, and replies that failed the output
contract. Each is a case where the skill's instructions and its judgement came
apart.

Your job is to write the amendment that would have prevented the most of them,
for ONE skill, in the project's own layer. You are not rewriting the skill: the
base ships with lookout and stays as it is. You are adding the rules this
project has actually taught it.

{{amendments}}

{{include:audience.md}}

## What makes a good amendment

- **Grounded.** Every rule you write must trace to specific signals below, and
  you must cite them. A rule with no evidence behind it is a guess, and a guess
  that permanently changes how every future run is judged is the worst thing
  you can do here.
- **Narrow.** Amend for the pattern you can see repeatedly, not for one
  incident. Two refutations of the same kind is a pattern; one is an anecdote.
- **Additive.** Say what to file and what not to file. Never restate the base
  rubric, and never contradict the closed category vocabulary or the closed
  region vocabulary: findings outside the categories are rejected at ingestion,
  and a region outside the set degrades to `content`, so a rule inventing a
  value in either is a rule that silently discards or mislabels work. Both
  vocabularies are part of every finding's identity, and only lookout's own
  code may change their shape.
- **Written to be read by the model doing the work AND by the person auditing
  it**, in the same voice as the skill it joins: direct, specific, and about
  what to do rather than about why the amendment exists. Put the why in
  `summary`, not in the amendment body. Somebody will read this rule months
  from now while trying to understand why lookout judged their screen the way
  it did, so it has to make sense to a reader who was not here when the
  signals came in: name the thing rather than a label for it, and say what a
  person would see on screen, not only what to file.
- **Never weakens the two-audience rule.** Every skill is governed by the
  audience section above: the prose lookout produces is read by an agent that
  will act on it and by a person deciding whether to believe it. An amendment
  that tells a skill to be terser, to lean on rule ids or category names
  instead of plain description, or to write only what an agent needs, is a
  regression however well the signals support the judgement underneath it.
  Amend what gets filed, not whether it stays understandable.
- **Small.** A handful of rules. If the signals do not support one, say so with
  an empty amendment rather than inventing something to say.

A by-design adjudication is the strongest evidence here. A person looked at the
defect, decided it was intended, and wrote down why. That reason is a standing
rule about this project, and it is the one signal carrying human judgement.

## When a new skill is the answer

If the signals cluster around something no existing skill covers, propose one
in `newSkill` instead of amending. Be honest about the bar: a new skill is
warranted when lookout is repeatedly wrong about a KIND of judgement it has no
instructions for, not when an existing skill needs another rule. Nothing invokes
a new skill until a verb is wired to it, so say in `summary` what would call it.

## The judging family

The visual judge is a family of skills. The `judge-core` skill carries the
shared rubric (severity, regions, procedure, the output contract), and each
`judge-*` panel skill owns the categories its body lists, composed onto the
core at judging time. Amend the panel when the lesson is about filing or not
filing its categories; amend `judge-core` only when the lesson is about
shared judging behavior. A lesson about one panel's categories never belongs
in a sibling panel.

## The skills

{{skills}}

## The signals

{{signals}}

## Output contract

Reply with ONLY one fenced json block, no prose before or after:

```json
{
  "skill": "<the skill this amends, from the list above>",
  "summary": "<one line: what this changes and why the evidence supports it>",
  "amendment": "<markdown rules to append to that skill in this project's layer, or an empty string>",
  "evidence": ["<source id of every signal this rests on>"],
  "newSkill": null
}
```

To propose a new skill instead, set `amendment` to an empty string and
`newSkill` to `{ "name": "kebab-case-name", "description": "<one line>", "body": "<the skill body>" }`.
Write the body as instructions to whichever model will run it. lookout adds the
frontmatter and the amendment slot itself, so do not write either.
