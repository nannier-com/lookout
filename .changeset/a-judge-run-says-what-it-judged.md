---
"@nannier-com/lookout": patch
---

A judge run now says what it actually judged, and one bad batch no longer costs
the whole run.

**Skipped shots are no longer cached as clean.** The output contract requires
every shot to appear in either `findings` or `cleanShotIds`, which exists so a
reply that quietly skipped one can be caught. Nothing read the result, so a
skipped shot was indistinguishable from a clean one, and `recordVerdicts` wrote
its whole view group into the ledger as `clean`. A later scoped re-check then
served that verdict from cache. `judgeBatch` now returns the shots the reply
accounted for in neither list, those groups are left out of the cache so they
are judged again next run rather than remembered as clean, an incident is
recorded, and the run reports them as `N NOT judged` rather than folding them
into the clean count.

lookout does not retry the batch to chase the missing verdict. A retry re-reads
every screenshot in the group at full cost, while simply not caching is free and
self-correcting.

**A failed batch no longer discards the run.** The per-batch workers had no
error handling and were awaited by `Promise.all`, while the ledger was written
once after all of them returned. A single timeout or unparseable reply in the
last batch therefore threw away every batch already judged, and the next run
paid to judge all of them again. Batches now fail individually: the failure is
recorded as an incident, reported in the run summary and in `failedBatches` on
the check outcome, its shots are left uncached, and the remaining batches stand.
Only a run where every batch failed is an error, because that one judged
nothing. A refuting pass that fails now leaves its findings standing and
unverified rather than losing them.

**One judge call per view group.** Batching packed several small view groups
into one call to save subprocesses, which quietly broke the cache: the rubric
asks for one finding per distinct defect on the most representative shot, so a
defect shared by two groups in the same batch was filed against one of them and
put the other's shots in `cleanShotIds`, recording that view as clean. The
prompt unit and the ledger unit are now the same thing. In practice this changes
little for a full run, where a view group of three form factors across two
schemes already filled the old default batch; it matters for runs narrowed to
one scheme or form factor, which is exactly where the packing happened. The
undocumented `--batch-size` flag is gone with it.
