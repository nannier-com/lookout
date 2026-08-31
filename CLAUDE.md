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
| what the judge is asked | `skills/<name>/SKILL.md`, never a string literal in code |
| how a judgement is made | `src/judge/` (engine, rubric, verify, ledger, criteria) |
| how findings become issues | `src/backlog/`, `src/issues/`, `src/fix/` |
| one step of `check` | `src/check/` (scope, plan, batches, outcome) |
| the local page | `src/ui/` for the server, `src/ui/client/` for the browser |
| what a verb prints or exits with | `src/verbs/<verb>.ts` |
| what lookout knows about itself | `src/report/learning.ts`, `src/skills/` |

A verb file is the shape of one command: parse flags, call into the modules
above, print, choose an exit code. When a verb starts holding the logic itself,
that is the signal to cut a directory for it, the way `check/` was cut.

## Rules the tooling enforces

- **300 code lines per file** (`max-lines`, comments and blanks not counted).
  Seven files predate the ceiling and are pinned at their current size in
  `eslint.config.mjs`: they may be split, they may not grow.
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
