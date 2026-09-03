---
"lookout": minor
---

Minor justification (new public capability): the settings panel points lookout
at another project, and remembers it.

The `Project` row under the cog was a label. It is a control now: a native
folder chooser beside a box you can type or paste a path into. Choosing one
re-resolves everything scoped to a project — its config, its own base URL and
calls-to-action consent, its queue, the board and the judges' transcript — so
the page is looking at the new repository without being restarted in it.

The choice is remembered, which is what the picker this replaces could not do
without a machine-wide home. The pointer is written to the directory the server
was STARTED in (`<launch>/.lookout/ui.json`), never the one it points at: a
pointer still cannot live inside the thing it points to, and the launch
directory is the somewhere else it needed. A `lookout ui` started there again
comes back pointed where you left it, and one whose remembered project has since
moved says so and serves the launch directory rather than refusing to start.

A directory that is no project at all is still refused rather than littered, and
one that is a repository without a config gets one written, exactly as launching
the verb inside it would.
