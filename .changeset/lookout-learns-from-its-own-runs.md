---
"@nannier-com/lookout": minor
---

lookout amends its own skills from what its runs got wrong, and a frozen set of
settled verdicts decides whether the amendment survives.

New user-visible capability: `lookout skills` (`list`, `diff`, `freeze`,
`replay`, `improve`). `improve` reads signals lookout already records for other
reasons, each one a case where its instructions and its judgement came apart:
findings the adversarial verifier refuted, findings a person adjudicated
by-design and wrote a reason for, defects that survived every attempt,
acceptance criteria that could not be decided from a screenshot, and replies
that failed the output contract. It writes the rules that would have prevented
the most of them into this project's own layer, through the new
`improve-skills` skill.

It applies automatically. What makes that safe is that the gate is evidence
rather than judgement: `.lookout/regression/` holds screenshots whose verdicts
were settled when the pixels were fresh, both what a person ruled intentional
and what the verifier confirmed. The candidate is replayed through the real
pipeline, judge then refuter, and an amendment that re-files a suppressed
finding or loses a confirmed one is rolled back with its violations written to
`.lookout/skills/history.jsonl`. Matching is by category, not by attribute: the
attribute is the judge's own wording and moves between runs on identical pixels,
so gating on it would reject good amendments for rewording.

An amendment nothing can grade is never applied. That covers an empty set, a
clone whose frozen pixels are not on this machine, and skills the set cannot
exercise; all three write `PROPOSED.md` and say why. `improve` can also propose
a new skill, which lookout writes with the frontmatter and amendment slot it
needs, and says plainly that nothing invokes it until a verb is wired to it.

The manifest is committed and the frozen pixels are not, so add
`.lookout/regression/shots/` to .gitignore; `lookout skills freeze` rebuilds
them from the evidence store.
