---
name: lookout
description: Verify UI work with the lookout visual AI tester: capture what the app actually renders across form factors, schemes, and platforms; judge it against best practices; verify a ticket's acceptance criteria; fact-check a visual assumption; track findings in the project backlog. Use BEFORE declaring UI work done, when a ticket carries acceptance criteria, when unsure whether a visual or responsive assumption holds, or when asked to audit an app's UI.
---

# lookout: evidence-based visual verification

lookout (`@nannier-com/lookout`, source at ~/Workspaces/lookout, runs via
`~/Workspaces/lookout/dist/cli.js` until the npm release lands) is a pure
oracle: it captures screenshots, runs deterministic checks, judges evidence
through the local `claude -p`, and tracks findings. It NEVER edits code and
NEVER starts services. You do the fixing; lookout verifies.

## When to reach for it

- You changed UI and are about to say "done": run `lookout check` (or at
  minimum `lookout capture`) on the affected routes first. Tests verify code;
  lookout verifies pixels.
- A ticket has acceptance criteria: `lookout verify --criteria <file|text>`
  returns per-criterion pass / fail / not-verifiable with evidence paths.
- You are unsure a visual assumption holds ("does the sidebar collapse below
  640px?", "is the dark-mode contrast readable?"): `lookout ask "..."`.
- Sweeping an app for conformance issues: `lookout check`, findings land in
  `.lookout/backlog.json`.

## Prerequisites (check once per machine)

`lookout doctor` reports everything. Judging (`check`, `verify`, `ask`)
shells out to `claude -p` and needs the standalone CLI logged in: if doctor
or a judge run reports "Not logged in", ask the user to run `claude` in a
terminal once and complete /login; `lookout doctor --handshake` confirms.
Capture-only verbs work regardless.

## The verbs

```bash
lookout targets                      # what this project declares, up or down
lookout capture --routes /checkout   # evidence only: shots + console/axe/overflow findings
lookout check                        # capture + AI judge; findings merge into the backlog
lookout check --routes /x --targets docs   # scoped re-check (ledger-cached, cheap)
lookout verify --criteria ticket.md  # acceptance criteria verdicts with evidence
lookout ask "is the empty state readable in dark mode?"
lookout backlog stats                # open findings by severity
lookout backlog check                # gate: schema, reasons, staleness
```

Exit codes: 0 clean, 1 findings or failed criteria, 2 execution error.
`--json` on any verb for machine-readable output. Zero-config mode works
anywhere: `lookout capture --url http://localhost:3000`.

## Per-project facts

- A repo with `.lookout/config.ts` is wired: targets, routes, state recipes,
  rubric extension, never-file suppressions live there. Wired today: canvas
  (the docs, 100 component routes + overlay recipes + native apps), ionize
  dashboard / auth / site (public routes through Caddy addresses).
- lookout never starts services. A down target prints its startHint; start
  the app the way that project intends (canvas: `cd docs && bun run dev`;
  ionize stack: ask the user to start it, NEVER run ionctl yourself).
- Native capture (`--platforms ios,android`) needs a booted simulator or
  emulator with the app installed; both schemes on device need the app's
  appearance URL param (canvas has one: `?scheme=light`).

## The fix loop

1. `lookout check` (or a scoped variant): findings merge into
   `.lookout/backlog.json` with stable fingerprints.
2. Fix the code in the target repo, per THAT repo's conventions (canvas: kit
   law applies: semantic boolean props, no styling escape hatches, skins in
   *.styles.ts, changeset per kit fix).
3. Re-check the affected scope: unchanged pixels stay cached; the fixed
   finding stops being re-found.
4. Adjudicate: `lookout backlog set <fingerprint> --status fixed --commit
   <sha>`; intended behavior gets `--status by-design --reason "..."`
   (suppressed forever after); after 2 failed fix rounds use `--status
   blocked --reason "..."` and move on.
5. `lookout backlog check` gates before you commit backlog changes.

## Guardrails

- Localhost targets only unless the user explicitly wants `--allow-remote`.
- Never judge intentionally-wrong demo content (docs "Don't" examples).
- Never type credentials into captured apps; authed areas wait for a session
  recipe feature.
- Findings are the app's problems, not lookout's: fix the app, or adjudicate
  with a reason; never edit backlog.json by hand.
