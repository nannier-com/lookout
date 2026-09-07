---
"@nannier-com/lookout": minor
---

Minor justification (new public capability): `direction` in `lookout.config.ts`
declares the project's design direction, as a shipped preset
(`minimalist-editorial`, `industrial-brutalist`, `premium-agency`,
`utility-dense`), the project's own DESIGN.md, or both, and the taste panel and
the refuter judge against it.

The taste panel ships judging the defaults every design practice rejects.
Beyond those, the practices contradict each other: no radius against soft
corners, gradients banned against gradients encouraged, one call to action
against exactly two. None of that is judgeable until a project says which
direction it chose, and this is where it says so. What a direction declares is
settled and never filed; the rules it adds are judged where a still can show
them, and its rules about motion, hover or code are not, because a capture
cannot see them.

lookout reads the file when it composes the prompt; the judge never opens it,
and the prompt names it by its config-relative spelling only. The first 12 KB
of a project's file reach the judge, with a Stitch-format `components:` table
dropped first when the file is over budget and a marker saying how many lines
were cut. The text is filled into the taste panel's composed prompt alone, so
it enters only that panel's cache key: editing a DESIGN.md re-judges taste and
leaves every other panel's verdicts standing. The refuter sees the same
direction in its "What the project declared" section, beside the `neverFile`
lines.

Presets ship in the package under `skills/judge-taste/directions/`; no brand's
DESIGN.md does. A legacy `.lookout/config.*` that names a direction file is
repointed when it migrates to the root, the way `rubric` is.
