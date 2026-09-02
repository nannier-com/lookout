---
"@nannier-com/lookout": patch
---

**The board and the backlog markdown read in words.** A card's headline is
the defect's own title (or the group's, "2 accessibility problems on /"),
not `category/attribute on routes`; the status pill says "still open", "fix
confirmed", "verifying now", "filed away"; the category chip is the phrase a
person reads ("accessibility", "interaction state") with its gloss on hover;
every defect carries a `rule category/attribute` line so the token is never
a bare label; each acceptance criterion says its verdict beside the mark
("met", "not met", "not verifiable", "not ruled") instead of a glyph a
viewer has to decode; the frozen pair says "screenshot", not "frame"; and
the record feed shortens a forty-character commit the way `git log` does.
`BACKLOG.md` drops the fingerprint column, links each row's issue number to
its document, and lists every fingerprint once under `## Identities`.
