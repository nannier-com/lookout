---
"@nannier-com/lookout": patch
---

Rule on evidence that moved, not on how the judge phrased itself today.

The judge is not deterministic: re-judging identical pixels can surface a
finding it did not mention last time and drop one it did. `verify-fix` was
treating both as facts about the fix, which broke it in two directions. A live
run with no fix applied at all came back `regressed`, blaming a session for two
findings it could not have caused, which burns an attempt and eventually blocks
a cluster over defects nobody touched. The mirror image was worse: a cluster
could PASS on unchanged pixels purely because the judge happened not to mention
its defect that time, letting variance alone close a real finding.

Pixel hashes are deterministic, so the ruling now turns on them. A finding only
counts as a regression if it appears on a screenshot whose pixels actually
changed, and nothing may pass while every screenshot in scope is byte-identical
to the previous run: that verdict is now `still-open`, with a note saying no
edit reached the rendered output and naming the usual causes. The rule is
extracted to `src/fix/rule.ts` as a pure function so each of these cases is
stated in a test.
