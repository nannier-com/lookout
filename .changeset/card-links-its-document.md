---
"@nannier-com/lookout": patch
---

Every card on `lookout ui` links its own `Issue.md`, and the page serves it at
`/issue/<id>/Issue.md`. The card has always printed the issue folder, which is
the right thing to hand somebody at a terminal and no use to somebody reading
the board: a browser refuses a `file://` link written into a page it loaded
over HTTP, so the document was unreachable from the one surface built for
reading issues. A card whose folder is not on disk shows no link at all rather
than one that answers 404, and the route serves that one file name under a
six-digit id and nothing else. `tools/ui-check` gained the fixture material and
the drive checks for both states, and its throwaway git checkout now commits at
a fixed date, so rebuilding the fixture stops reporting two changed learning
views that were only new commit hashes.
