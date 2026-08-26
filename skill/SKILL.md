---
name: lookout
description: Verify UI work with the lookout visual AI tester: capture what the app actually renders across form factors, schemes, and platforms; judge it against best practices; verify a ticket's acceptance criteria; fact-check a visual assumption; track findings in the project backlog. Use BEFORE declaring UI work done, when a ticket carries acceptance criteria, when unsure whether a visual or responsive assumption holds, or when asked to audit an app's UI.
---

# lookout

lookout (`@nannier-com/lookout`, source at ~/Workspaces/lookout, runs via
`~/Workspaces/lookout/dist/cli.js` until the npm release lands) is a visual
oracle: it captures what an app renders, judges it, and rules on whether a
defect is gone. It never edits code and never starts services.

**lookout carries its own instructions.** It is meant to be driven by any
agent, not only this one, so the operating contract lives in the tool rather
than in this file:

```bash
lookout protocol
```

Run that first. It prints what lookout is, the loop, the dispatch protocol for
`check --auto`, the exit codes, and the rules. This file exists only to point
you at it and to carry the few facts that are specific to this machine.

## When to reach for it

- You changed UI and are about to say "done": run `lookout check` on the
  affected routes first. Tests verify code; lookout verifies pixels.
- You want the defects fixed, not just found: `lookout check --auto`, then
  follow the dispatch protocol it prints.
- A ticket has acceptance criteria: `lookout verify --criteria <file|text>`.
- You are unsure a visual assumption holds: `lookout ask "..."`.

## Machine-specific facts

- Judging shells out to `claude -p` and needs the standalone CLI logged in.
  `lookout doctor` reports it; if it says "Not logged in", ask the user to run
  `claude` in a terminal once and complete /login.
- Wired projects: canvas (the docs, 100 component routes, overlay recipes and
  native apps), ionize dashboard (13 admin routes behind a demo-admin
  `signIn`), ionize auth and site (public routes through Caddy addresses).
- lookout never starts services. A down target prints its startHint; start the
  app the way that project intends (canvas: `cd docs && bun run dev`; the
  ionize stack: ask the user to start it, NEVER run ionctl yourself).
- Native capture (`--platforms ios,android`) needs a booted simulator or
  emulator with the app installed.
- Authenticated targets sign in via the project's `signIn` hook, which clicks a
  demo account rather than typing credentials. If a run comes back full of
  findings about a login screen, read the `off-origin` finding before believing
  any of them: the shots are of a different application.
