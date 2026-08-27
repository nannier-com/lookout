---
"@nannier-com/lookout": minor
---

Every issue now carries acceptance criteria, and only lookout ticks them.

New user-visible capability: an issue states what would prove it fixed, from the
moment it is filed. The list is on the card, in `ISSUE.md`, and in `issue.json`,
so the agent fixing the defect reads the same criteria lookout will rule against
rather than discovering them from a failed verification.

Where they come from depends on who found the defect. A deterministic check
states itself, passing, with no model involved and no cost: an axe violation
becomes "No accessibility violation of rule `region` on / at desktop, dark
scheme". A judged finding gets criteria from the judge, which saw the defect and
is the only thing that can say what its absence looks like; the `visual-judge`
skill's output contract now requires them. A finding filed before that existed
falls back to its own `expected` prose, so no issue is left with nothing to test.
Every issue also carries the guard the verdict rule already enforced silently:
pixels have to have moved.

`verify-fix` rules them, each by the thing that can actually decide it. The
deterministic checks rule their own by re-running. The pixel hashes rule the
re-capture guard. The judge-authored ones get an independent pass over the fresh
screenshots through the `verify-acceptance` skill, rather than being inferred
from whether the original finding came back: two ways of being wrong beat one
way twice. A criterion ruled `unmet` blocks a pass. One the evidence cannot
decide is `not-verifiable` and does not, because a criterion the pixels cannot
settle would otherwise make an issue permanently unclosable.

The boxes are lookout's. They render as marks rather than as
`<input type="checkbox">`, so there is no control for a viewer to toggle and
assistive tech reads a state rather than an editable field, and the UI server
gained no endpoint that could change one. `lookout backlog check` now fails an
issue with no criteria, the way it already failed a by-design finding with no
reason.
