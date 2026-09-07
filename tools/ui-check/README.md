# ui-check

The gate for anything the page renders. Green type checks and green tests say
nothing about what a browser draws, and this repo has now found three real bugs
that every other gate passed over: a filter bar that could not be hidden, and
two optional fields dereferenced after being guarded on a copy.

The manual commands run in this order around a change:

```bash
bun tools/ui-check/run.ts fixture              # a throwaway project with issues, history and incidents
bun tools/ui-check/run.ts serve                # start lookout ui against it, prints the port
bun tools/ui-check/run.ts shots before         # capture every view
#   ... make your change, restart serve ...
bun tools/ui-check/run.ts shots after
bun tools/ui-check/run.ts diff before after    # pixel comparison, per view
bun tools/ui-check/run.ts drive                # every interaction check
```

CI runs the complete gate without a second terminal:

```bash
bun run test:ui                                # fixture + server + shots + drive + cleanup
```

`ci` exits nonzero for screenshot page/console errors or a failed interaction,
and always stops the server it started. Chromium must already be installed;
the shared validation action installs it before this command.

Everything lands under `.lookout-ui-check/` in the repo root, which is ignored.

A refactor should come out of `diff` identical, or differing only in a clock:
the fixture carries a "seen 2d" style relative time that advances between runs.
Anything else is a change you did not mean to make, and the crop the diff writes
beside a differing view shows you what it was.
