---
"@nannier-com/lookout": minor
---

Every AI capability lookout has is now a skill file, and a project can amend any
of them.

New user-visible capability, which is what makes this a minor: a project can put
its own `.lookout/skills/<name>/SKILL.md` next to its config, and lookout layers
it over the shipped skill at the slot that skill declares. That is a second
extension point beside `rubric` and `neverFile`, and unlike those it reaches the
refuter, the acceptance verifier, and the fact-checker rather than the judge
alone.

The four capabilities (`visual-judge`, `refute-finding`, `verify-acceptance`,
`fact-check`) ship as `skills/<name>/SKILL.md` in the standard Agent Skill
layout, each carrying the whole prompt shape with placeholders. lookout supplies
data only: the shot manifest, the paths, the question. Nothing about what the
model is asked to think lives in TypeScript any more, and any harness that reads
skills can read lookout's.

`rubric/BASE.md` moved to `skills/visual-judge/rubric.md` unchanged; the
`rubricVersion` header it carried became the skill's `version`, and the ledger
key is now `<groupHash>@v<judgeSkillVersion>@<model>`. Cached judge verdicts fall
out of cache once on upgrade, which is the intended behaviour whenever the rules
change. `config.rubric` and `config.neverFile` keep working exactly as before.
