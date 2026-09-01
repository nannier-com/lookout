---
"@nannier-com/lookout": minor
---

The config is `lookout.config.ts` at the project root, and lookout writes it.

New user-visible capability: a project's config now sits at its root, beside
`package.json`, instead of inside the gitignored `.lookout/` directory, so it is
committed and shared like any other tool's config. lookout creates it rather
than only reading it. `lookout init` writes it, and a verb that needs a config
and finds none writes one too, seeded from `--url` when the run supplied one and
left as a template to edit when it did not.

A project still holding `.lookout/config.ts` keeps working and is moved up to
the root by the first run that finds it, with the `rubric` and route `design`
paths inside it repointed, since those resolve relative to the config file.
Anything the move could not place on its own is named rather than guessed at.
`.lookout/config.{ts,js,json}` still loads, so nothing breaks on upgrade.
