---
"@nannier-com/lookout": minor
---

**A judge can say which other screenshots of a view show the defect it just
filed, and those screenshots count as ruled on.** The rubric asked a judge to
file one finding per defect on the most representative shot and to name the
other affected shots in the problem text. The output contract then had no
bucket for a shot named that way: `reply.ts` accounted for a shot only as a
finding's `shotId` or in `cleanShotIds`, so every shot mentioned only in prose
came back unaccounted. That made the whole (view group, panel) pair
uncacheable, so its judge call was re-bought on the next run, and the run
reported those shots as not judged. It was the single largest source of
`judge-rejected` incidents in real use, and it fell hardest on the panels that
judge a view as a whole.

Findings now carry `alsoShotIds`: the other shots of THIS view showing the
SAME defect. Ingestion validates each id against the batch, drops the primary
and any duplicate, and expands the rest into their own findings, each stamped
`siblingOf` with the shot the judge chose. That happens before the adversarial
verifier, so a sibling is ruled on its own evidence and an over-listed one is
refuted on its own shot without touching the primary; the refuter's prompt
prints it as a short row pointing at the primary's index rather than repeating
the paragraph once per shot. Identity is unchanged: form factor and scheme are
already part of a fingerprint, and the cluster key fuses the sightings back
into one issue. A sibling id naming a shot outside the batch is dropped with
one incident line and never costs the finding. Prose lapses and refuter-supplied
plain sentences are counted on the primary alone, so one badly written problem
teaches its panel one lesson rather than four.

The accounting sentence in the contract now names all three buckets, and
`judge-core` moves to version 9 with output `judge-findings-v3`, which re-keys
every cached verdict once per project.
