---
"@nannier-com/lookout": minor
---

`lookout ui` gets a settings panel, and a base URL that moves a config's targets
instead of discarding the config.

New user-visible capability. Configuring lookout was previously something the
Play button did on its way past: clicking it opened a folder dialog, and the
answer was forgotten when the server stopped. There was also no way to say
"this project, but the app is on a different port" at all.

**A cog beside Play.** It opens a panel showing where lookout is pointed, every
target the config declares with its route count, and whether each one answers
right now. A wrong port is visible before a run is spent on it rather than
after. Play only ever runs.

**Play is grey until something is configured**, and green when it would really
work. A green "go" that can only produce an error is a lie told by a colour.

**Settings are remembered** in `~/.lookout/ui.json`, so `lookout ui` with no
arguments comes back pointed where you left it. The server also starts
unconfigured now instead of exiting, which it had to: the one screen that can
fix an unconfigured project could not previously be opened until the project was
already configured.

**New `--base-url` flag**, for the CLI as well as the panel. It overrides the
origin of every target while keeping the config's routes, viewports, state
recipes and sign-in hook. This is deliberately not `--url`, which short-circuits
the config file entirely and captures "/" of a single synthetic target; that is
right for pointing lookout at something it knows nothing about, and wrong for a
configured project whose dev server came up somewhere else today. A target
mounted under a path keeps that path, since the path is where the app lives and
the origin is which machine it is on.
