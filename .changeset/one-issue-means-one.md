---
"@nannier-com/lookout": patch
---

`--first` really does record one issue now.

It stopped the judge after one *finding*, which is a different thing and did not
hold anyway. Three ways a single click could still file fifteen issues:

Two batches judged in parallel, so the second one's findings landed after the
first had already met the limit, having been paid for only to be discarded.
Judging is serial whenever a limit is set.

One batch is a view group and can return several findings at once, so the limit
was met and overshot in the same step. And the deterministic findings, which are
free and never went near the judge, were merged in full regardless of any of it:
a run could stop at one judged finding and still file every accessibility
violation in the capture.

Narrowing now happens once, across both channels, at the point findings are
written to the backlog. One issue means one cluster, not one finding, so a root
cause seen on six screenshots stays whole: splitting it would hand over a third
of a defect. The worst severity wins, ties go to the cluster covering the most
screenshots.

Two things follow. If the capture already found something, `--first` skips
judging altogether, because deterministic findings are free and certain and
judging on would spend minutes and money on findings about to be dropped. And
the run says how many findings it saw but did not file, since silently
discarding real findings would report the application as healthier than it is.
