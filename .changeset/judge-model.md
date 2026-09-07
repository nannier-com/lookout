---
"@nannier-com/lookout": minor
---

Minor justification (new public capability): the model a judge rules with is
chosen from the settings panel, per project.

It was a `--model` flag with a default written out in ten places, which meant
the page could not offer it and nobody running `lookout ui` could change it
without leaving the page. The panel now carries a row per AI lookout can judge
with, the choice is stored in that project's `.lookout/ui.json`, and the run the
play button starts is given it.

Per project rather than per browser, unlike the tool selector, because it is not
a preference about the reader: the ledger files a verdict under the model that
gave it, so judging a project with a different model is a different body of
evidence about that repository.

Free text rather than a menu, because the names a CLI accepts change under
lookout and a list baked into the page would be wrong within a release while
still looking authoritative. An empty box means lookout's own default, and the
panel reports what that default is rather than printing a name of its own.

The value is refused unless it could be a model name, and in particular it may
not begin with a dash: it becomes the word after `--model` in a spawn, and a
stored setting must not be able to arrive as an option nobody typed.
