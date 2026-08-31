---
"@nannier-com/lookout": patch
---

`check --first` (the walk behind the UI's play button) now re-tests routes
lookout has already ruled fully fixed, first, on every run. A fix in one area
can regress another, and the walk used to order fixed routes with the
never-dirty rest, behind a stop rule that ends the run at the first standing
issue, so a regression on a fixed route stayed invisible until the whole
backlog ahead of it cleared. Walking them first costs almost nothing when
they are unchanged (one capture and a ledger hit, no judge calls), and when
their pixels moved the judge runs exactly where a regression could be: the
merge reopens the finding and the walk stops with the newest breakage while
its cause is still the most recent commit.
