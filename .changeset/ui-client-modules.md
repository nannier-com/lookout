---
"@nannier-com/lookout": patch
---

The page's front end is real source now. Its styles and its script used to live
inside a template literal in the server, which meant nothing in the build ever
read them: no type check, no lint, and a stray escape reached the browser as a
syntax error with every gate still green.

The styles are `src/ui/client/*.css`, served as files. The script is a set of
ES modules under the same directory, type-checked against the very types the
server serialises: `/api/status` now has a written-down `StatusPayload`, the
settings panel a `SettingsView`, and the tool list a `ToolChoice`, so a payload
field that changes shape fails the build instead of the page. Type-checking the
client immediately found two latent bugs, both places where an optional field
was guarded on a copy and then dereferenced.

Running from a checkout needs no build step: the server transpiles the client's
TypeScript on the way out, which lookout can do for free because it already runs
under bun. An install serves the emitted modules the build ships in `dist`.

Two lint rules keep the boundary honest, both verified to fire: client code may
not touch node globals, and may not import a server module except as a type.
