---
"@nannier-com/lookout": patch
---

`lookout init` now keeps the whole `.lookout/` directory out of git, not just
the evidence: the backlog, issue folders and learned skill layers are
lookout's working state, per-checkout by decision. The README's
where-things-land section states the consequence plainly (state does not
follow the repo, deleting the directory re-rolls issue ids) and names
`config.ts` as the one authored file worth un-ignoring when a team should
share it.
