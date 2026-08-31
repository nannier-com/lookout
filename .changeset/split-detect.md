---
"@nannier-com/lookout": patch
---

Split `src/design/detect.ts` into the jobs it was doing: reading the directory
tree (`detect-tree`), resolving which kit a repository has (`detect-kits`),
looking for controls the application built for itself (`detect-handrolls`), and
the pass that assembles an inventory out of the three. Behaviour is unchanged,
verified by `lookout design-system --audit` producing output identical to the
run before the split.

With this the `max-lines` debt list in `eslint.config.mjs` is empty: no file in
the repository is exempt from the 300-line ceiling any more, and `CLAUDE.md` no
longer describes pins that do not exist.
