---
"@nannier-com/lookout": patch
---

The last traces of the projects lookout was built against are gone, and two
stale package names are corrected.

A follow-up to the earlier sweep, from a second audit pass over the whole tree.

- `/components/button` was the only route example on lookout's public type
  surface (`RouteDef.path`, and twice in the capture store), which ships in
  `dist/*.d.ts` and therefore shows in every consumer's editor tooltips. It is
  a design-system docs route and made lookout read like a design-system tool.
  Now `/settings` and `/settings/profile`.
- Test fixtures collectively sketched a real deployment: an OAuth2
  `login_challenge` parameter, an identity server's `/identities` admin route,
  and four real ports. Individually harmless, together a map. Renamed to
  neutral values; the tests assert on structure, so nothing else changed.
- The generated MIT LICENSE named `@nannier/lookout`, a package that does not
  exist. The grant in the published tarball now names the real one.
- `bun.lock` still carried the pre-rename scope, disagreeing with
  `package.json`. Aligned.
- `.gitignore` now covers `.claude/`, so local agent settings cannot be
  committed into a public repository by accident.
