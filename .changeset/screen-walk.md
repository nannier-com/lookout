---
"@nannier-com/lookout": minor
---

Minor justification (new public capability): lookout reads a project's source
for its screens and walks them one at a time, with an AI doing the clicking.

- `lookout map` reads the source (routers, page and screen directories,
  navigation components) with a read-only AI call and writes `.lookout/map.json`:
  a tree of every route and every state a route can show, what to open on its
  parent to reach each, its risk, and the source that declares it. Screens the
  map finds beyond `lookout.config.ts` are walked and in scope; the config is
  never edited. The map goes stale when the source it was read from changes.
- `lookout check` walks the map when one exists: reach a screen, capture it
  across the form-factor and scheme matrix, judge it, file its findings, then
  the next screen. A screen is reached by replaying what reached it before, or,
  when nothing has, by a navigator: Claude Code or Codex handed lookout's own
  navigation tool server (snapshot, open, click, type, press, hover, scroll,
  back, tap, swipe, key, look, arrive) over a web page or a booted iOS or
  Android simulator. What the navigator did is recorded into the map and
  replayed on later runs without a model. `--first` still stops at the first
  screen with standing findings; `--no-map` captures the matrix as before;
  `--max-screens`, `--max-navigator-calls`, `--budget-usd`, `--replay-only`,
  `--no-replay`, `--navigator-model` and `--screens` bound and narrow the walk.
- `verify-fix` re-captures a finding filed on a mapped state by replaying its
  recording, so a fix on a screen behind a click can be ruled on.
- Device captures no longer need `appearanceParam` to photograph both schemes:
  the simulator or emulator is switched between them, and the read-back still
  files a mismatch when the app did not follow.
- `lookout doctor` reports `idb` and what an AI can do to each device platform
  on the machine.
