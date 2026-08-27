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
| `check`   | capture + AI judge against the base rubric plus the project rubric; findings merge into `.lookout/backlog.json`. `--auto` also writes one fix brief per root cause, ready to dispatch |
| `verify-fix` | rule on a claimed fix: re-capture and re-judge one cluster, then pass it or hand it back with a fresh brief |
| `verify`  | judge the app against acceptance criteria (`--criteria ticket.md` or inline text); per-criterion pass / fail / not-visually-verifiable with evidence |
| `ask`     | answer a free-form question about the rendered app, grounded in fresh screenshots |
| `backlog` | adjudicate findings: merge, set statuses (fixed / by-design / blocked, with mandatory reasons), `plan` to re-emit the dispatch plan for free, regenerate the report, `check` for staleness |
| `targets` | list configured targets and probe reachability |
| `init`    | scaffold `.lookout/config.ts` |
| `status`  | what the run in flight is doing, folded out of the event log; exit 1 while a run is going, so an agent can poll it |
| `ui`      | a local page rendering that same log live, with thumbnails, findings and verdicts, for a person to watch |
| `protocol`| the operating contract, printed by lookout itself, for whichever agent is driving it |
| `doctor`  | verify prerequisites |

Exit codes: `0` clean, `1` findings / failed criteria, `2` execution error, so
agents and CI can gate on the result. `verify-fix` adds `3` for a cluster
blocked after exhausting its attempts. Every verb takes `--json` for
machine-readable output.

## Watching a run

A run takes minutes, and a subprocess's stdout does not reach its caller until
it exits. So lookout narrates to `.lookout/evidence/events.jsonl` as it goes,
and two readers render it while the run is still going:

```bash
lookout status          # for an agent: phase, shots, findings, dispatched work
lookout ui              # for a person: the same log as a live local page
```

Both are readers. Either can watch a run started by anything, in any terminal.

`capture`, `check` and `verify-fix` also composite every shot into one labelled
contact sheet, a view's dark and light captures side by side and defect-carrying
tiles marked, so a session can see what lookout saw for the cost of one read.
Full-resolution paths are printed beside it for close reading.

## Auto mode

lookout is run by agents rather than read by people, and auto mode is the
handshake between the oracle and whatever is doing the fixing. lookout still
edits nothing and spawns nothing.

```bash
lookout check --auto              # judge, then write the dispatch plan
lookout backlog plan              # re-emit the plan from the backlog, judging nothing
```

`--auto` streams. Deterministic clusters are dispatched before judging even
starts, because a rule cannot be contradicted by a judge, and each judged
cluster is dispatched as soon as the routes it touches are done. A cluster that
grows after it was dispatched is re-emitted as an amendment.

It clusters open findings by root cause rather than by screenshot: one
target + category + attribute, so a theme that never switches is one unit of
work across every route it spoils rather than one per shot. Co-located
accessibility violations group by route instead, because an axe rule id names
the rule that fired rather than the thing that is wrong, and one malformed
widget trips several at once.

Each cluster gets a self-contained brief under `.lookout/evidence/fix/`: the
defect, its contact sheet and full-resolution screenshots, the repository to
change, the rule files that govern it (CLAUDE.md, AGENTS.md and the like,
discovered and listed by path, because lookout cannot assume the agent's harness
loaded them), and the JSON the fix session must reply with. `PLAN.json` lists the clusters and the
protocol. The orchestrating session spawns one subagent per brief, so it carries
cluster ids and verdicts while the subagent carries the evidence.

When a session reports back, lookout rules on the claim:

```bash
lookout verify-fix --issue <id> --commit <sha> --note "<root cause>"
```

That re-captures and re-judges only that cluster's routes. Exit `0` means the
defect is gone and the backlog is adjudicated to `fixed` with the commit. Exit
`1` means it is not, and a fresh brief has been written carrying what the judge
sees now, for a new session. Exit `3` means the cluster exhausted
`--max-attempts` (default 2) and is recorded as `blocked` with a reason. A fix
session never grades its own work.

## Safety defaults

- Targets must be localhost unless `--allow-remote` is passed explicitly.
- lookout never starts services; a down target prints the project's
  `startHint` and exits.
- Judging runs `claude -p` with read-only tool access, cwd-pinned to the
  evidence directory.

## Per-project config

`.lookout/config.ts` is a TypeScript module (the CLI runs under bun, so
recipes are real functions) default-exporting a `LookoutConfig`. Everything
below is optional except `targets`.

```ts
import type { LookoutConfig } from "@nannier-com/lookout";
import type { Page } from "playwright";

const config: LookoutConfig = {
  project: "myapp",

  targets: [
    {
      name: "app",                       // handle for --targets and fingerprints
      url: "http://localhost:3000",
      startHint: "bun run dev",          // printed when down; lookout never starts services
      readyPath: "/",                    // polled for reachability
      routes: [
        "/",                             // string shorthand
        { path: "/checkout", name: "Checkout", states: ["cart-open"] },
        { path: "/settings", element: "main" },  // element screenshot instead of full page
      ],
    },
  ],

  // Viewport presets (desktop-first defaults: 1440x900 / 834x1112 / 390x844).
  viewports: { phone: { width: 375, height: 812 } },

  // How the app switches dark/light:
  //   emulate (default)  prefers-color-scheme emulation
  //   url-param          lookout appends ?<param>=dark|light to every route
  //   recipe             this module also exports setScheme(page, scheme)
  scheme: { mode: "url-param", param: "scheme" },

  // Named interaction recipes. A route opts in via states: ["name"]; each
  // state is captured at every requested form factor and scheme, right after
  // prepare() returns. restore() puts the page back; without it lookout
  // reloads between states.
  states: {
    "cart-open": {
      prepare: async (page: Page) => {
        await page.getByRole("button", { name: "Cart" }).click();
        await page.getByRole("dialog").waitFor();
      },
      restore: async (page: Page) => {
        await page.keyboard.press("Escape");
      },
    },
  },

  // Project judging rules, layered into the visual-judge skill in every judge
  // prompt. The extension can carry its own `rubricVersion: N` header; the
  // higher of skill and extension versions keys the ledger cache, so bumping
  // either forces fresh judging.
  rubric: "./rubric.md",

  // One-line suppressions for things the base rubric would flag but this
  // project does on purpose.
  neverFile: ["the marketing hero intentionally overflows on phone"],

  // Native apps (capture with --platforms ios,android). Both schemes on a
  // device need appearanceParam: the app must read the scheme from the deep
  // link, because OS-level appearance flips cannot reach apps that manage
  // their own theme.
  native: {
    target: "app",
    ios: { deepLinkScheme: "myapp", bundleId: "com.example.myapp" },
    android: { deepLinkScheme: "myapp", bundleId: "com.example.myapp", settleMs: 14000 },
  },
};

export default config;
```

### Skills: where lookout's AI behaviour lives

Every AI capability is an instruction file, not a string in the binary. They
ship in the standard Agent Skill layout, one directory each:

```
skills/
  visual-judge/       SKILL.md + rubric.md: what counts as a defect, and how to file it
  refute-finding/     SKILL.md: the adversarial pass that kills false findings
  verify-acceptance/  SKILL.md: ruling on a ticket's criteria from evidence alone
  fact-check/         SKILL.md: answering one question from screenshots
```

A skill carries the whole prompt shape, placeholders and all. lookout supplies
only data: the shot manifest, the paths, the question. Each declares
`{{amendments}}`, the slot where a project's own layer lands.

Every judge prompt is therefore assembled from the `visual-judge` skill
(severity ladder, the closed category vocabulary, the judging procedure, the
universal never-file list), then this project's `.lookout/skills/visual-judge/`
layer if it has one, then its `rubric` file, then its `neverFile` lines.
Findings outside the category vocabulary are rejected at ingestion, so project
extensions refine judgment; they cannot invent new taxonomies.

The composed `version` of the judge skill keys the ledger, so amending a skill
invalidates exactly the cached verdicts it could have changed.

### Where things land

```
.lookout/
  config.ts        committed: the project's targets and recipes
  backlog.json     committed: adjudicated findings (managed via `lookout backlog`)
  BACKLOG.md       committed: generated report (regen via `lookout backlog regen`)
  ledger.json      committed if you want cross-machine judge caching
  issues/<id>/     committed: one folder per issue, named by its six-digit id
                     issue.json, ISSUE.md, state.json committed;
                     shots/ and recheck/ gitignored with the evidence
  skills/          committed: this project's layer over lookout's shipped skills
  evidence/        gitignored: screenshots + capture-report.json + judge-report.json
```

### The fix loop (for agents)

lookout never edits code. The loop it is built for:

1. `lookout check` in the target repo: findings merge into the backlog.
2. Fix the code in that repo, per that repo's own conventions.
3. `lookout check --targets x --routes /y` to re-capture and re-judge just
   the affected scope; unchanged pixels stay ledger-cached.
4. `lookout verify-fix --issue <id> --commit <sha> --note "<root cause>"` is
   the only thing that closes a finding. It rules on that issue alone: a fix
   that clears the defect and causes another one passes, and the new defect is
   filed as its own numbered issue with a note saying which fix surfaced it.
5. `lookout backlog set <fingerprint> --status fixed --commit <sha>`; use
   `--status by-design --reason "..."` for intended behavior (suppressed in
   every later merge) and `--status blocked --reason "..."` after repeated
   failed attempts.
6. `lookout backlog check` as the gate: schema, mandatory reasons, missing
   issue ids, markdown freshness, and drift detection all fail loud.
