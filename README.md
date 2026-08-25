# lookout

A project-agnostic visual AI tester. lookout captures what an app actually
renders (web pages across form factors and color schemes; iOS simulator and
Android emulator screens), judges the evidence against UI best practices and
per-project rules through the locally installed Claude Code CLI, verifies
acceptance criteria from a ticket, answers free-form fact-check questions, and
tracks findings in an adjudicated per-project backlog.

lookout is a pure oracle: it never edits code and never starts services. Agents
(or humans) working in the target repo do the fixing; lookout verifies.

## Requirements

- [bun](https://bun.sh) (the CLI runs under bun so TypeScript configs are
  first-class)
- [Claude Code](https://claude.com/claude-code) logged in locally (judging
  shells out to `claude -p`)
- Playwright chromium: `bunx playwright install chromium`
- Optional, for native capture: Xcode command line tools (iOS simulator) and
  Android platform-tools (`adb`)

Check everything with:

```bash
lookout doctor
```

## Quick start

```bash
# zero-config: point it at any local app
lookout targets --url http://localhost:3000

# per-repo setup
lookout init                  # scaffolds .lookout/config.ts
lookout targets               # resolve + probe the configured targets
```

## Verbs

| verb      | what it does |
| --------- | ------------ |
| `capture` | screenshots + deterministic findings (console errors, overflow, axe), no AI |
| `check`   | capture + AI judge against the base rubric plus the project rubric; findings merge into `.lookout/backlog.json` |
| `verify`  | judge the app against acceptance criteria (`--criteria ticket.md` or inline text); per-criterion pass / fail / not-visually-verifiable with evidence |
| `ask`     | answer a free-form question about the rendered app, grounded in fresh screenshots |
| `backlog` | adjudicate findings: merge, set statuses (fixed / by-design / blocked, with mandatory reasons), regenerate the report, `check` for staleness |
| `targets` | list configured targets and probe reachability |
| `init`    | scaffold `.lookout/config.ts` |
| `doctor`  | verify prerequisites |

Exit codes: `0` clean, `1` findings / failed criteria, `2` execution error, so
agents and CI can gate on the result. Every verb takes `--json` for
machine-readable output.

## Safety defaults

- Targets must be localhost unless `--allow-remote` is passed explicitly.
- lookout never starts services; a down target prints the project's
  `startHint` and exits.
- Judging runs `claude -p` with read-only tool access, cwd-pinned to the
  evidence directory.

## Per-project config

`.lookout/config.ts` declares targets, routes, viewport overrides, the scheme
mechanism (`emulate` | `url-param` | `recipe`), named interaction recipes
(open an overlay, switch an in-app form factor), a rubric extension, and
never-file exclusions. See `lookout init` for a commented template.
