---
"@nannier-com/lookout": patch
---

Deterministic accessibility findings join the region model. Axe already
records the violating nodes' selector paths, and a violation whose reported
nodes all sit inside the same `nav`, `header` or `footer` landmark (element or
explicit role; class names never consulted, samples of larger violations never
trusted) is derived as that shell region. A chrome a11y cluster then keys by
region instead of route, so one malformed nav landmark stops minting one issue
per route; when a cluster key re-derives unambiguously, the existing issue id
succeeds to the new key with its folder, acceptance verdicts and history, the
old key recorded in `priorKeys`. `backlog check` gains an `issue-orphaned`
report for records whose key clusters nothing any more; ids are never pruned.
A load/save round trip on a real project backlog stays byte-identical.
