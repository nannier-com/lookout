---
"@nannier-com/lookout": patch
---

The launch control is the tool's mark with a play beside it, and dropped
findings are no longer invisible.

Each issue card carried the words "open in Claude Code", repeated on every card
and restating what the navbar toggle already says. It is now the selected tool's
own mark next to a green play triangle: the card shows what it opens in rather
than spelling it out, and switching the toggle re-marks every card. The name
stays in `aria-label` and the tooltip, and the control pulses while opening
instead of swapping its text, which would have deleted the marks.

The page also says what a run saw and did not file. A `--first` run records one
issue and drops the rest, and those were real findings: on a live project a
single run filed one console error and dropped three other defects, including
two scheme mismatches, with nothing on the page admitting they existed. There is
now a line above the board saying how many were seen and not filed, and that
running again picks up the next one.

The evidence heading reads **Where lookout saw it** rather than "What lookout
saw". An issue lists the screenshots the defect was actually observed on, which
is usually fewer than the captures of that route, and the old wording invited
the reasonable question of why one file was named when six sat in the folder.
