# Working on lookout

lookout is a project-agnostic visual AI tester: it captures what an app renders,
judges the evidence through the local Claude Code CLI, and tracks findings in an
adjudicated backlog. It is a pure oracle. It never edits the code it is looking
at and never starts services; agents and humans do the fixing, lookout rules on
whether the defect is gone.

Several sessions often work in this repo at once, sometimes in worktrees under
`.claude/worktrees/`, all sharing one `.git`. Most of what follows exists to
make that safe.

## Project-agnostic, by construction

lookout judges other people's projects and is specific to none of them. Two
rules keep it that way, and a change that breaks either is wrong even when
every gate is green:

- **No judged project is special.** Nothing in this repo may name, detect, or
  special-case a particular project: no hard-coded project names, paths,
  ports, URLs, or per-project branches in code, skills, or defaults.
  Everything project-specific reaches lookout through that project's own
  layer: its `lookout.config.ts`, its rubric, its `.lookout/` skill
  amendments.
- **lookout's own requirements never live inside a judged project.** Whatever
  lookout needs in order to run ships with the package (code, skills, the
  base rubric, the reply contracts) or lives in `LOOKOUT_HOME`, default
  `~/.lookout` (incidents, heals, self-heal runs, ui settings, and one
  capture workspace per project: shots, the capture report, the run log, all
  of it rebuildable by a single capture). What lookout writes into a
  project's `.lookout/` is the durable record of that project and belongs to
  it: the backlog, the ledger, the issue folders (each carrying its own
  frozen before/after pixels), its amendments. If lookout would fail against
  a fresh checkout of a brand-new project because a file it needs exists only
  inside some other project, that file is in the wrong place; move it into
  the package or `LOOKOUT_HOME`.

## Where a change goes

| you are changing | it lives in |
| --- | --- |
| where a project's config lives, or who writes it | `src/config-locate.ts` (found), `src/config-write.ts` (created, migrated), `src/config.ts` (loaded) |
| how a screen is captured | `src/capture/` (web, native, checks, contact sheet, store) |
| what an AI capability is asked | `skills/<name>/SKILL.md`, never a string literal in code |
| how lookout talks to the CLI at all | `src/judge/claude.ts` |
| the judge's prompt or its reply contract | `src/judge/engine.ts` |
| what a view group or a batch is | `src/judge/grouping.ts` |
| the rubric, the refuter, the ledger, criteria | `src/judge/` |
| which panel owns a category, or when one judges | `src/judge/panels.ts` (the partition is data; a test holds it to the skill files) |
| a finding's identity, or how a channel is ingested | `src/backlog/fingerprint.ts`, `src/backlog/ingest.ts` |
| what happens when a finding is seen again | `src/backlog/merge.ts` |
| the backlog's shapes, its validation, its markdown | `src/backlog/lib.ts`, `check.ts`, `report.ts` |
| how findings become issues you act on | `src/issues/`, `src/fix/` |
| one step of `check` | `src/check/` (scope, plan, batches, outcome) |
| one step of `verify-fix` | `src/verify/` (evidence, acceptance, code) |
| what the board contains | `src/report/board-types.ts` |
| how the board is derived | `src/report/board-durable.ts` (state), `board-live.ts` (narration) |
| the local page's server | `src/ui/` (routes, payload, evidence, document, run, project, session) |
| the local page in the browser | `src/ui/client/` (`shell.css` for the frame, `board.css` for a card, one module per area) |
| how lookout amends its own instructions | `src/skills/` (history, replay, amend, signals, regression) |
| what a verb prints or exits with | `src/verbs/<verb>.ts` |

A verb file is the shape of one command: parse flags, call into the modules
above, print, choose an exit code. When a verb starts holding the logic itself,
that is the signal to cut a directory for it, the way `check/` was cut.

## Rules the tooling enforces

- **300 code lines per file** (`max-lines`, comments and blanks not counted).
  No file is exempt: the ones that predated the ceiling have all been split, and
  `eslint.config.mjs` carries no pins. Adding one would be a decision to keep
  debt rather than a record of inheriting it, so split the file instead.
- **`src/ui/client/` is browser code.** No node globals, and no value import
  from outside that directory: server types come in through `import type`, which
  the compiler erases. Both rules are in `eslint.config.mjs` and both were
  checked by making them fail.
- **The page's script and its markup are separate files**, so `test/ui-page.test.ts`
  asserts every id the script paints into exists in the shell, that every asset
  the shell links can be served, and that every client module transpiles.

## Verifying a change

Gates, in the order they fail cheapest first: `bun run typecheck`, `bun run lint`,
`bun test`, `bun run build`.

Green gates are not enough for two kinds of change:

- **Anything the page renders.** `tools/ui-check` is that gate, and it is four
  commands rather than a description: `fixture` builds a throwaway project with
  something in every part of the page, `serve` points the ui at it, `shots
  <label>` captures eight views across both colour schemes and a narrow
  viewport, `diff <a> <b>` compares them pixel by pixel and crops whatever
  moved, and `drive` clicks through the page asserting what each control does.
  Capture before your change and after it: a refactor should come out
  ALL IDENTICAL, because the fixture's one clock is frozen. Three real bugs have
  been found this way that every other gate passed over.
- **A verb.** The suite covers the modules, not the composition: nothing calls
  `runCheck`, for instance. Run the verb for real against a served page, with
  `LOOKOUT_CLAUDE_BIN` pointed at `test/mock-claude.ts` so no model is called.
- **Anything the build ships.** The page's assets are files now, and a build
  that stopped copying them would pass every gate and serve a blank page to
  anyone who installed it. `npm pack`, install the tarball into a throwaway
  directory, and run `lookout doctor` and `lookout ui` from
  `node_modules/.bin`.

Never delete or weaken a test to make a change pass. If a test is wrong, say so
and fix the test as its own change.

## Working alongside other sessions

- Commit each phase as soon as it is done and push it. Uncommitted work in a
  shared checkout can be reset out from under you.
- Before starting, `git status`. Files another session is mid-edit in are theirs;
  pick a different seam or wait.
- Stage your own files by name. `git add -A` in this repo will sweep in whatever
  another session left in the tree.
- `git pull --rebase` before pushing; CI pushes version commits of its own.

## Releases

Changesets only, never a local `npm publish`. Patch by default. A minor needs a
user-visible capability named in the changeset body. Nothing here bumps a major,
ever: that is the owner's call in the moment they ask for it.
