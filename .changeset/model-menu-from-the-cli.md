---
"@nannier-com/lookout": minor
---

The judge's model is chosen from a menu of what the installed CLI offers, with
that CLI's version under it.

New user-visible capability: the settings panel reads the model names off the
Claude Code install on this machine and offers them as a menu, where it
previously took a model as free text and could not say what the valid names
were. It also prints the version of the CLI those names came from.

The old text box was reasoned, not lazy: a list of model names baked into
lookout would be wrong within a release while still looking authoritative. That
reasoning still holds, and is why the menu asks rather than declares. Nothing in
this repo names a model. The names come from the typings the CLI's own package
ships beside its binary, which carry the aliases as a union type; an install
whose binary sits outside its package (a wrapper script, a package manager's
shim) falls back to the aliases `--help` documents for `--model`. An install
that answers neither gets the text box back, because refusing to accept a typed
name would be a worse answer than the one being replaced.

A name the menu does not offer is still reachable through Custom, and a stored
name that is not in the menu comes back selected there rather than being
dropped. That keeps a pinned full model name available for judging that has to
stay reproducible across a CLI upgrade.

The version line is the other half of the same probe. It says which install the
names came from, which is what to look at when a name somebody expected is not
in the list.
