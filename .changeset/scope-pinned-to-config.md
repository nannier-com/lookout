---
"@nannier-com/lookout": patch
---

Judging scope is pinned to the current config. The capture report
accumulates across runs, so shots of routes or states removed from the
config stayed in scope forever, paying capture and refreshing findings
about screens nobody can reach. They now leave judging scope immediately
(with a counted note), and an unscoped capture, the one moment lookout
sees the config's whole intent, retires them from the report; scoped
captures never prune. Native shots are exempt, and findings on removed
routes are never auto-closed: they stop refreshing and surface through the
existing backlog staleness checks for a person.
