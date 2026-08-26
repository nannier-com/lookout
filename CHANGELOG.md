# @nannier-com/lookout

## 0.4.3

### Patch Changes

- 443f0dd: Rule on evidence that moved, not on how the judge phrased itself today.

  The judge is not deterministic: re-judging identical pixels can surface a
  finding it did not mention last time and drop one it did. `verify-fix` was
  treating both as facts about the fix, which broke it in two directions. A live
  run with no fix applied at all came back `regressed`, blaming a session for two
  findings it could not have caused, which burns an attempt and eventually blocks
  a cluster over defects nobody touched. The mirror image was worse: a cluster
  could PASS on unchanged pixels purely because the judge happened not to mention
  its defect that time, letting variance alone close a real finding.

  Pixel hashes are deterministic, so the ruling now turns on them. A finding only
  counts as a regression if it appears on a screenshot whose pixels actually
  changed, and nothing may pass while every screenshot in scope is byte-identical
  to the previous run: that verdict is now `still-open`, with a note saying no
  edit reached the rendered output and naming the usual causes. The rule is
  extracted to `src/fix/rule.ts` as a pure function so each of these cases is
  stated in a test.

## 0.4.2

### Patch Changes

- 749720f: Judge one view group per call by default (batch size 6, was 10).

  A view group, one route and state across its form factors and schemes, is
  already the unit the rubric compares within, so a larger batch buys the judge no
  context it can use. It does hold every finding in the batch hostage until the
  whole batch returns: on full-page screenshots that ran to several silent
  minutes, which defeats the point of streaming. `--batch-size` still overrides.

## 0.4.1

### Patch Changes

- 36a5e0e: Fix `verify-fix` passing a deterministic cluster that never got fixed.

  The ruling compared the cluster against freshly judged findings only. Rule
  violations come back from capture rather than from the judge, so an
  accessibility cluster (every `axe-*` finding) matched nothing on re-check and
  was marked fixed with its violations still firing, which is the one outcome the
  oracle exists to prevent. It now compares against both channels.

## 0.4.0

### Minor Changes

- 3bbebd9: Feed the session while the run is still going, show a person what is happening,
  and carry the operating contract in the tool rather than in one vendor's plugin.

  New user-visible capability across three fronts.

  **Live feedback.** A run takes minutes and a subprocess's stdout does not reach
  its caller until it exits, so lookout now narrates to
  `.lookout/evidence/events.jsonl` as it goes. `lookout status` folds that into
  "what is happening right now" for an agent to poll (exit 1 while a run is in
  flight), and `lookout ui` serves a local page that renders the same log live,
  with screenshot thumbnails, findings as they are confirmed, dispatched clusters
  and their verdicts. Both read the log, so either can watch a run started by
  anything, anywhere.

  `check --auto` now streams its dispatch instead of batching it to the end.
  Deterministic clusters go out before judging even starts, since rules cannot be
  contradicted by a judge, and each judged cluster goes out as soon as the routes
  it touches are done. Verification moved to a per-batch pass to make that
  possible. A cluster that grows after it was dispatched is re-emitted as an
  amendment rather than silently left stale, and `verify-fix` re-judges the whole
  cluster scope, so a partial fix comes back still-open with a fresh brief.

  **Seeing what lookout saw.** `capture`, `check` and `verify-fix` composite every
  shot into one labelled contact sheet, with a view's dark and light captures side
  by side and defect-carrying tiles marked. One image answers "what does this
  actually look like" for the cost of a single read, and full-resolution paths are
  listed beside it, absolute, for close reading. Each fix brief carries its own
  cluster sheet.

  **Agent-agnostic by construction.** `lookout protocol` prints the operating
  contract: what lookout is, the loop, the dispatch protocol, the exit codes and
  the rules. It lives in the tool so any agent can read it, not in a Claude skill
  that other harnesses cannot see and that would drift from the code. Brief
  wording no longer assumes one harness's tool names.

  **Project rules are named, not assumed.** lookout hands work to an agent whose
  configuration it cannot see, so every brief now discovers and lists the rule
  files governing the target repository (CLAUDE.md, AGENTS.md, GEMINI.md,
  CONVENTIONS.md, .cursorrules and the like, in the repo, its subtree and its
  ancestors) and requires them to be read before any edit, with the project rule
  winning wherever it conflicts with the brief.

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
