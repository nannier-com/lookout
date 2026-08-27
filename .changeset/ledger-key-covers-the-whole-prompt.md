---
"@nannier-com/lookout": patch
---

The judge cache is now keyed on the instructions as well as the pixels, so a
cached verdict can no longer outlive the rules that produced it.

The key was `<viewGroupHash>@v<judgeSkillVersion>@<model>`, which left three ways
for lookout to serve a verdict formed under rules that had since changed. A
project `rubric` file edited without bumping its `rubricVersion` past the shipped
skill's version altered the judge prompt while the key stood still. A
`config.neverFile` change never touched a version at all, so suppressions could
be added or removed with no effect on the cache. And the `refute-finding` skill's
version was never in the key even though what the ledger stores is that skill's
output, so amending the refuter left every stale verdict standing.

The key is now `<viewGroupHash>@v<version>@<promptHash>@<model>`, where
`promptHash` covers the composed judging and refuting instructions as they were
assembled for that run. Editing a rubric, a `neverFile` line or either skill
re-judges exactly what it could have changed, and nothing has to be bumped by
hand. The version stays in the key so it is still readable in `ledger.json`.

Cached findings also stopped claiming to be verified. A cache hit stamped
`verified: true` on everything it returned, including findings recorded by a
`--no-verify` run and the medium and low findings the adversarial pass never
looks at. The stored flag is now read back as written, so the `(verified)` marker
in the CLI and the `verified` field in `judge-report.json` mean what they say.

Existing ledgers re-judge once on the next run, because the key shape changed.
That is the correct behaviour for a cache whose old entries could not be shown
to match the current rules.
