# Working on lookout

lookout is a project-agnostic visual AI tester: it captures what an app renders,
judges the evidence through the local Claude Code CLI, and tracks findings in an
adjudicated backlog. It is a pure oracle. It never edits the code it is looking
at and never starts services; agents and humans do the fixing, lookout rules on
whether the defect is gone.

Several sessions often work in this repo at once, sometimes in worktrees under
`.claude/worktrees/`, all sharing one `.git`. Most of what follows exists to
make that safe.

## Where a change goes

| you are changing | it lives in |
| --- | --- |
| how a screen is captured | `src/capture/` (web, native, checks, contact sheet, store) |
| what an AI capability is asked | `skills/<name>/SKILL.md`, never a string literal in code |
| how lookout talks to the CLI at all | `src/judge/claude.ts` |
| the judge's prompt or its reply contract | `src/judge/engine.ts` |
| what a view group or a batch is | `src/judge/grouping.ts` |
| the rubric, the refuter, the ledger, criteria | `src/judge/` |
| a finding's identity, or how a channel is ingested | `src/backlog/fingerprint.ts`, `src/backlog/ingest.ts` |
| what happens when a finding is seen again | `src/backlog/merge.ts` |
| the backlog's shapes, its validation, its markdown | `src/backlog/lib.ts`, `check.ts`, `report.ts` |
| how findings become issues you act on | `src/issues/`, `src/fix/` |
| one step of `check` | `src/check/` (scope, plan, batches, outcome) |
| one step of `verify-fix` | `src/verify/` (evidence, acceptance, code) |
| what the board contains | `src/report/board-types.ts` |
| how the board is derived | `src/report/board-durable.ts` (state), `board-live.ts` (narration) |
| the local page's server | `src/ui/` (routes, payload, evidence, run, project, session) |
| the local page in the browser | `src/ui/client/` (`shell.css` for the frame, `board.css` for a card, one module per area) |
| how lookout amends its own instructions | `src/skills/` (history, replay, amend, signals, regression) |
| what a verb prints or exits with | `src/verbs/<verb>.ts` |

A verb file is the shape of one command: parse flags, call into the modules
above, print, choose an exit code. When a verb starts holding the logic itself,
that is the signal to cut a directory for it, the way `check/` was cut.

## Rules the tooling enforces

- **300 code lines per file** (`max-lines`, comments and blanks not counted).
  Two files still predate the ceiling and are pinned at their current size in
  `eslint.config.mjs`: they may be split, they may not grow. Raising one of
  those numbers is not how to add code to a file on that list.
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

- **Anything the page renders.** Screenshot it. Start the ui against a fixture
  project (`bun src/cli.ts ui --port <n>` with `LOOKOUT_HOME` pointed at a
  throwaway directory), drive it with Playwright, which is already a dependency,
  and compare against shots taken before the change. Check both colour schemes
  and a narrow viewport. If the change touches wiring rather than styling, drive
  the interactions too: a filter click, the tool toggle, the settings panel, the
  rail. Two real bugs have been found this way that every gate passed over.
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
