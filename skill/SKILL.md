---
name: lookout
description: Verify UI work with the lookout visual AI tester: capture what the app actually renders across form factors, schemes, and platforms; judge it against best practices; verify a ticket's acceptance criteria; fact-check a visual assumption; find which design system a project uses and where a visual fix belongs; track findings in the project backlog. Use BEFORE declaring UI work done, when a ticket carries acceptance criteria, when unsure whether a visual or responsive assumption holds, when about to fix UI in a project that has a component kit, or when asked to audit an app's UI.
---

# lookout

lookout is a visual oracle: it captures what an app renders, judges it, and
rules on whether a defect is gone. It never edits code and never starts
services.

**lookout carries its own instructions.** It is meant to be driven by any
agent, not only this one, so the operating contract lives in the tool rather
than in this file:

```bash
lookout protocol
```

Run that first. It prints what lookout is, the loop, the exit codes, and the
rules. This file exists only to point you at it and to carry the handful of
practical notes that are easier to hit than to work out.

## When to reach for it

- You changed UI and are about to say "done": run `lookout check` on the
  affected routes first. Tests verify code; lookout verifies pixels.
- You want the defects fixed, not just found: `lookout check`, fix what it
  filed, then have `lookout verify-fix` rule on each fix.
- A ticket has acceptance criteria: `lookout verify --criteria <file|text>`.
- You are unsure a visual assumption holds: `lookout ask "..."`.
- Before fixing anything lookout filed in a project with a design system: read
  the issue's **Where this belongs** section first. The defect was photographed
  on a screen and is usually fixed in a component, which is a different file and
  often a different package.

## Practical notes

- A running `lookout ui` server keeps executing the dist it was started with;
  rebuilding does not reach it. If the ui page looks stale while
  `lookout protocol` prints current text, that is why. After `bun run build`,
  restart any live ui server: `pgrep -fl "cli.js ui"` finds it, `lsof -a -p
  <pid> -d cwd` names the project it was serving, then kill it and relaunch
  `ui --port <port>` from that same cwd. Safe mid-`check`: the ui reads state
  from disk, so a restart loses nothing.
- Judging shells out to `claude -p` and needs the standalone CLI logged in.
  `lookout doctor` reports it; if it says "Not logged in", ask the user to run
  `claude` in a terminal once and complete /login.
- Which projects are wired, and what each one targets, is whatever
  `.lookout/config.ts` says in the repo you are standing in. `lookout targets`
  lists them and probes whether they are reachable; read that rather than
  assuming.
- lookout never starts services. A down target prints that project's own
  `startHint`; start the app the way the hint says. If the hint names an
  orchestration tool the operator runs by hand, ask them rather than running
  it yourself.
- Native capture (`--platforms ios,android`) needs a booted simulator or
  emulator with the app installed.
- `lookout design-system` says what the project is built out of and where a
  visual fix belongs. Run it before fixing UI in an unfamiliar repository: the
  answer that matters most is whether the kit is this repository's to edit or an
  installed dependency, because that decides whether the fix is to the component
  or to the application's use of it. Never patch a kit inside `node_modules`.
- Placing a defect costs a model call per new issue (about $0.30). `lookout
  check --no-placement` skips it, `--max-placements N` changes the cap. The
  leftovers are placed on the next run rather than lost.
- Findings on the `code` channel were read out of the source, not photographed,
  so they have no screenshots and `verify-fix` rules on them by re-reading the
  source. An issue with no `img/` folder is not a broken issue.
- Authenticated targets sign in via the project's `signIn` hook, which clicks a
  demo account rather than typing credentials. If a run comes back full of
  findings about a login screen, read the `off-origin` finding before believing
  any of them: the shots are of a different application.
