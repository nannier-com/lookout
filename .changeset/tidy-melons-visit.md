---
"@nannier-com/lookout": patch
---

**`lookout ui` serves the project it is started in.** The page no longer asks
for a folder or remembers one: start it in a project and it reads the
`lookout.config.ts` at that root, writes one when the project has none (with
the `.lookout/` ignore line beside it), and keeps its base URL and its
calls-to-action consent in that project's own `.lookout/ui.json`. Started in a
directory that is no project at all, it refuses and says how to proceed instead
of leaving files there. `--url` and `--config` are unchanged and still write
nothing.

To look at another project, restart the page there. What that gives up is a
running page that could be re-pointed, and the native folder picker that did
it; what it buys is that lookout keeps nothing in a home directory of its own,
and that the page's settings travel with the checkout they describe. The
consent is still stored against the directory it was given for, so a
`.lookout/` copied into another checkout does not carry permission to click
that one's controls.

`~/.lookout/ui.json` is no longer read or written. Nothing now reads
`~/.lookout` at all.
