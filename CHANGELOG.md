# @nannier-com/lookout

## 0.3.0

### Minor Changes

- 617d5c4: Add auto mode: `lookout check --auto`, `lookout verify-fix`, and `lookout
backlog plan`.

  New user-visible capability. lookout is executed by agents rather than read by
  people, so auto mode turns a backlog into work an orchestrating session can
  dispatch, and then rules on the result. lookout still edits nothing and spawns
  nothing.

  - `check --auto` clusters open findings by root cause (one target + category +
    attribute; co-located accessibility violations group by route, because an axe
    rule id names the rule that fired rather than the thing that is wrong), writes
    one self-contained brief per cluster under `.lookout/evidence/fix/`, and emits
    a `PLAN.json` carrying the dispatch protocol. Each brief is a complete prompt:
    the defect, the screenshots to read, the repository to change, the rules, and
    the JSON the fix session must reply with. The orchestrating session therefore
    holds cluster ids and verdicts rather than findings.
  - `verify-fix --cluster <id>` re-captures and re-judges only that cluster's
    routes and rules on the claim: exit 0 passed (backlog adjudicated to fixed
    with the commit), 1 not fixed (a fresh brief is written carrying what the
    judge still sees, for a new session), 2 execution error, 3 blocked after
    exhausting `--max-attempts` (default 2, recorded with a mandatory reason). A
    fix session never grades its own work.
  - `backlog plan` re-emits the same dispatch plan from the backlog alone, so
    resuming a fix loop costs nothing.
  - `--severity` sets the dispatch floor, critical and high by default.

### Patch Changes

- 5b39339: Key the judge cache by view group instead of by single shot.

  The rubric asks the judge to compare a view's dark/light pair and its
  form-factor progression, but the cache was keyed on one shot's pixel hash. On a
  scoped re-check after a fix, the changed shot re-judged while its unchanged
  partner was served from cache and never entered the batch, so the judge was
  asked for a comparison with one side missing and quietly stopped filing it. A
  colour-scheme or responsive finding therefore read as fixed when nothing had
  been fixed.

  A view group is now one target + platform + route + state across every form
  factor and scheme; its cache key covers every member's pixel hash, so any member
  changing re-judges the group whole. Batching treats a view group as atomic: an
  oversized group ships alone rather than being split across batches. Existing
  ledger entries miss once and re-warm.

## 0.2.0

### Minor Changes

- 71b3fd8: Capture authenticated routes, compare against design hand-offs, and never
  mislabel a shot that wandered off the target.

  Three new capabilities, all project-agnostic; lookout still knows nothing about
  how any given app authenticates or which design tool drew its hand-off.

  `TargetDef.signIn?: (page) => Promise<void>` runs once per target before its
  routes are captured. The run shares one browser context, so whatever session
  the hook establishes persists across every route, form factor and scheme. A
  project supplies its own flow (clicking a demo-account button, walking an OAuth
  redirect, seeding a token); if the hook throws, the target's routes are skipped
  and recorded as a `signIn` failure rather than photographed signed-out under a
  signed-in label.

  `RouteDef.design?: string` points a route at a design hand-off image, resolved
  relative to the config file. The judge reads it alongside every shot of that
  route and compares one to one. The hand-off is a reference, not an authority:
  the rubric has lookout rule on each divergence by user impact, so it can find
  the build improved on the hand-off (contrast, touch targets, truncation) and
  decline to file it, find the hand-off right and the build drifted, or find both
  wrong and say what correct would be. A new `design-parity` category covers a
  divergence that is only a divergence. Rubric version is now 2, so cached
  judgements re-run.

  A new `off-origin` deterministic check compares each shot's final URL against
  its target's origin. An app that bounces to a login host or an SSO provider was
  previously captured and filed under the route that had been requested, so every
  finding on that shot silently described a different application. That is now a
  critical finding on the shot, ranked alongside `blank-shot` because both mean
  the pixels are not what the shot claims to be. Same-origin redirects stay
  silent.

## 0.1.1

### Patch Changes

- d6e7c70: Publish the package publicly. Scoped npm packages default to restricted
  access; `publishConfig.access: "public"` in package.json is the mechanism npm
  always honors, independent of the changesets-level `access` setting.
