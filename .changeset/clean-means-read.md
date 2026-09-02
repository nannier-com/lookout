---
"@nannier-com/lookout": patch
---

**A form factor the judge never opened is never recorded clean, and every check says what it judged per form factor.** lookout now keeps every `Read` a judge makes; a shot the reply called clean whose file (or every piece of it) the model never opened is downgraded to "nobody ruled on this", left out of the cache, judged again next run, and written to the incident log with the form factors it skipped. `lookout check` prints one line per platform counting each form factor's shots judged, cached and carrying findings, and a second line naming any form factor that was not judged; `--json` carries the same tally under `formFactors`.
