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

The fixture supplies its own executable Claude CLI probe with fixed version and
model help output. The UI gate sets `LOOKOUT_CLAUDE_BIN` to that executable, so
it never invokes a developer's installed CLI and behaves the same on CI hosts
where Claude Code is absent.

Everything lands under `.lookout-ui-check/` in the repo root, which is ignored.

A refactor should come out of `diff` identical, or differing only in a clock:
the fixture carries a "seen 2d" style relative time that advances between runs.
Anything else is a change you did not mean to make, and the crop the diff writes
beside a differing view shows you what it was.

## Why some views are clipped

The page sets `body { overflow: hidden }` and scrolls the board inside its own
container, so a full-page screenshot is the viewport and nothing below it. A
card is taller than the viewport, which makes every section past roughly its
midpoint invisible to a `view`: the commit that rewrote the pre and post fix
comparison from a horizontal strip into two columns came out of `diff` as
`board-done.png identical`, with 45% of the section's pixels changed.

The `pairs-*` views are `section` captures instead. They scroll a card's divider
into the board's own scroll container and clip to the card, so what they frame
is the part of it no full-page view can reach. A section capture is anchored on
what a card holds rather than on where it sits, so it fails loudly when that
markup goes rather than quietly framing a different card, and its height is
fixed rather than measured, so a layout change reports as pixels in a stable
frame with a crop. Each height stops short of the "On disk" paths, which are
absolute and would otherwise differ between checkouts rather than between
revisions; the capture checks that rather than trusting it.

Add a section to a card and it is covered by nothing until it gets one of these.
