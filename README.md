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
lookout init                  # writes lookout.config.ts at the project root
lookout targets               # resolve + probe the configured targets
```

## Verbs

| verb      | what it does |
| --------- | ------------ |
| `capture` | screenshots + deterministic findings (console errors, overflow, axe), no AI |
| `check`   | capture + AI judge against the base rubric plus the project rubric; findings merge into `.lookout/backlog.json` |
| `verify-fix` | rule on a claimed fix: re-capture and re-judge one issue's routes, then close it or leave it open with a note on what the judge still sees |
| `verify`  | judge the app against acceptance criteria (`--criteria ticket.md` or inline text); per-criterion pass / fail / not-visually-verifiable with evidence |
| `ask`     | answer a free-form question about the rendered app, grounded in fresh screenshots |
| `backlog` | adjudicate findings: merge, set statuses (fixed / by-design / blocked, with mandatory reasons), regenerate the report, `check` for staleness |
| `targets` | list configured targets and probe reachability |
| `design-system` | what the project is built from (component kit, tokens, adoption), and where a visual fix belongs; `--audit` reads the application and says whether it is actually built out of that kit |
| `skills`  | lookout's own instructions: `list`, `diff`, `freeze`, `replay`, `improve` |
| `self-heal` | fix what lookout keeps getting wrong, in lookout's own source |
| `init`    | write `lookout.config.ts` at the project root (and migrate a pre-root `.lookout/config.ts`) |
| `status`  | what the run in flight is doing, folded out of the event log; exit 1 while a run is going, so an agent can poll it |
| `ui`      | a local page rendering that same log live, with thumbnails, findings and verdicts, plus a second area for what lookout has changed about itself |
| `protocol`| the operating contract, printed by lookout itself, for whichever agent is driving it |
| `doctor`  | verify prerequisites |

Exit codes: `0` clean, `1` findings / failed criteria, `2` execution error, so
agents and CI can gate on the result. `verify-fix` adds `3` for an issue
blocked after exhausting its attempts. Every verb takes `--json` for
machine-readable output.

## Watching a run

A run takes minutes, and a subprocess's stdout does not reach its caller until
it exits. So lookout narrates to `.lookout/evidence/events.jsonl` as it goes,
and two readers render it while the run is still going:

```bash
lookout status          # for an agent: phase, shots, findings, issues
lookout ui              # for a person: the same log as a live local page
```

Both are readers. Either can watch a run started by anything, in any terminal.

`capture`, `check` and `verify-fix` also composite every shot into one labelled
contact sheet, a view's dark and light captures side by side and defect-carrying
tiles marked, so a session can see what lookout saw for the cost of one read.
Full-resolution paths are printed beside it for close reading.

## Watching lookout change itself

`lookout ui` has two areas, switched from the icon rail down the left edge. The
first is the issues: what lookout found in the application. The second is
lookout on lookout, where `skills improve` and `self-heal` become something you
can read rather than files you have to know to open:

- **its instructions**: every skill with the version this project judges at,
  which ones this project has amended, any amendment written down as a proposal
  because nothing could grade it, the frozen screenshots that gate the next one,
  and every amendment applied, rolled back or proposed, a rollback carrying the
  settled verdict that killed it
- **its own code**: the failures lookout keeps hitting on this machine, the
  heals a gate reverted with the gates that failed and the diff kept on disk,
  and the commits that stuck

The rail's dot says when either is happening right now, from whichever area is
open: both verbs hold a lock file while they run, and the page reads it.

## Design systems

Most applications are built out of a component kit, and a defect found on a
screen is usually fixed in a component: a different file, and often a different
package. Fix it on the screen instead and the kit stays broken for every other
consumer, the screen acquires an override that will drift, and the next person
to touch that component has no idea why it is special.

So lookout reads the repository and works out what it is built from:

```bash
lookout design-system          # the inventory
lookout design-system --refresh   # re-read the repository rather than the cache
```

It resolves a kit four ways, and the distinction that matters most is whether
the kit is **this repository's to edit**:

- the repository IS the kit (a design system's own repo), told from an ordinary
  application by whether the package publishes an entry point
- a workspace-local kit, found by asking which workspace package the
  application source actually imports
- a vendored kit such as shadcn/ui, found by its marker file and located on disk
- an installed kit from the dependency list, which is **not** editable here: the
  fix is to the application's use of it, never a patch inside `node_modules`

The result caches to `.lookout/design-system.json`. Where the scan cannot work
it out (an in-house kit with no dependency, marker or workspace package to name
it), declare it and the declaration wins:

```ts
export default {
  targets: [...],
  designSystem: {
    name: "House",
    packageRoot: "../packages/ui",
    componentRoots: ["../packages/ui/src/components"],
    importPrefixes: ["@house/ui"],
    tokenFiles: ["../packages/ui/src/tokens.ts"],
  },
};
```

Working out where a defect belongs costs one model call per newly filed issue
(roughly $0.30 on sonnet), capped per run. Turn it off with
`lookout check --no-placement`, or change the cap with `--max-placements N`;
whatever is left over is placed on the next run rather than dropped.

Every issue lookout files in such a project carries a **Where this belongs**
section, above the description of the defect on purpose: somebody who reads
what is wrong first has already started planning to fix it on the screen they
saw it on. The section names the file to change, why there and not the other
place, how many other callers a kit change would reach, and what it moves.

lookout also files what it can see without a screenshot. A control an
application hand-rolls out of raw elements, in a project whose kit already
provides it, is a real defect that no photograph can show: it drifts from the
kit the moment either side changes, it is invisible to the kit's own tests, and
it hides whatever gap in the kit made hand-rolling it seem necessary. Those are
filed on their own channel and ruled by re-reading the source, so `verify-fix`
closes them on evidence exactly like any other issue.

### Is the application actually built out of its kit

Having a kit and using it are different facts, and only the second one shows up
in the code. So lookout reads the application as well as scanning it.

The scan is a regex: it fires on a declaration whose name ends in a control word,
in a file that imports the kit nowhere. Both restrictions keep it honest, and
together they miss the common case, which is a screen that imports the kit for
its text and layout and then builds a button out of a styled `div` in the same
file. No pattern separates that from ordinary scaffolding, because the difference
is what the thing IS.

The reading pass is the `kit-conformance` skill, handed the kit's actual export
list and the files densest in raw interactive markup. It adds the hand-rolls the
scan cannot see and refutes the ones the scan got wrong, and nothing it says is
taken on trust: every claim names a file, a symbol and a line, the symbol is
looked up in the file and the file's own line wins, and a kit component the kit
does not export is dropped rather than repeated.

```bash
lookout check                       # reads the application as part of the run
lookout check --no-conformance      # skip it
lookout check --max-conformance 12  # read at most 12 files
lookout design-system --audit       # read it on its own; files nothing, exits 1 on findings
```

It is on by default because it is nearly free the second time. A verdict is kept
per file, keyed on that file's own bytes plus the skill's version and the kit's
export list, so an unchanged file costs nothing, a changed one is read again, and
amending the skill or moving the kit drops every cached verdict at once. A file
the reply never accounted for is recorded as unread rather than cached clean.

Two defects come out of this, and they are not the same work. A **duplicate**
has something in the kit to be replaced by, and the finding names it. A **gap**
does not: the kit ships no equivalent, so the fix is to add the control to the
kit, backwards-compatibly, and consume it from there. Findings the reading pass
filed are ruled by asking it again about that file, never by the scan, because
the scan is exactly what could not see them in the first place.

## Issues

Open findings group into issues by root cause rather than by screenshot: one
target + category + attribute, so a theme that never switches is one issue
across every route it spoils rather than one per shot. Co-located
accessibility violations group by route instead, because an axe rule id names
the rule that fired rather than the thing that is wrong, and one malformed
widget trips several at once.

Each issue gets a six-digit id and a folder under `.lookout/issues/<id>/`, and
`Issue.md` in that folder is the self-contained document a fix session is
handed: what is wrong and where, the screenshots (copied into `img/pre/` and
listed by absolute path), the acceptance criteria it will be graded against,
and what lookout has ruled so far. The pictures are frozen when the issue is
filed rather than read live, because the evidence store keeps one file per
view and overwrites it on every capture: without that, a dossier opened after
the next run describes the defect using a picture of whatever replaced it. lookout writes the folders and rules on
the outcomes; who fixes an issue, and how, is not lookout's call.

Every card on `lookout ui` links its own `Issue.md`, and the page serves it: a
browser will not follow a `file://` link out of a page it loaded over HTTP, so
the folder path a card prints is only useful to somebody with a terminal open.
An issue whose folder is not on disk shows no link rather than one that answers
404.

When a fix is claimed, lookout rules on the claim:

```bash
lookout verify-fix --issue <id> --commit <sha> --note "<root cause>"
```

That re-captures and re-judges only that issue's routes. Exit `0` means the
defect is gone and the backlog is adjudicated to `fixed` with the commit. Exit
`1` means it is not: the finding stays open, with a note on what the judge
sees now. Exit `2` means lookout could not rule, and no attempt was spent.
Exit `3` means the issue exhausted `--max-attempts` (default 2) and is
recorded as `blocked` with a reason. `--commit` may be left out (HEAD is
read); `--note` is recorded with the attempt verbatim and printed in the
issue's `Issue.md` for whoever tries next, beside what lookout observed in the
repository and what the judge saw. A fix session never grades its own work.

Each screenshot is compared against the capture of the previous ruling, or
against the frame frozen when the issue was filed: a `check` or `capture` run
between the edit and the ruling does not move that baseline, so a real fix is
never ruled "nothing changed" because the workspace already held it.

### Pre and post fix, on every issue

Proving a defect gone destroys the evidence of it. The evidence store writes
each view back to the path it came from, so any capture of that route overwrites
the picture of what was wrong, and a card reading the store can only claim to
show the defect until the next run.

So every issue is frozen when it is filed. The **pre-fix** frame is copied aside
by the save that files the finding, which is the last moment the store still
holds the pixels the judge ruled on, and it is written once: a third fix attempt
still compares against the defect as filed rather than as the last attempt left
it. The **post-fix** frame is copied when `verify-fix` rules a fix passed, which
is the only moment lookout will say the screen is fixed. They live in the
issue's own folder, under `issues/<id>/img/pre/` and `img/post/`, with
`frames.json` beside them saying what each is a picture of; no capture writes
there. The card pairs them per view, saying which half is missing while an
issue is still open.

An issue that has already spent a fix attempt is never backfilled: something has
claimed to change that screen since it was filed, so its store frames are of
unknown vintage and filing them as the defect would be a picture of somebody's
fix under the wrong label. `lookout backlog check` lists issues with no pre-fix
frame instead.

A fixed issue also carries **the commit it landed in**, linked to wherever the
repository lives: GitHub, GitLab, Bitbucket and Azure by their own URL shapes,
any other forge by the `/commit/<sha>` convention with its host shown beside it,
and a bare sha when the checkout has no remote. "Fixed in" is a verdict lookout
reached; "Claimed at" is an attempt still open.

### Filing an issue away

A confirmed fix is not work any more, and the board is for work. `lookout ui`
offers **Archive** on a done issue, where an open one offers to hand off to a
coding tool:

```
.lookout/issues/<id>/  ->  .lookout/issues/archive/<id>/
```

The record decides which side the folder belongs on and the next save moves it,
so the two cannot drift, and anything holding an id finds the folder wherever it
is. Archiving records *why*, so an issue somebody fixed is never described as one
somebody adjudicated intentional.

Two things it will not do. It refuses while any finding is still open, because
hiding live work is the one failure an archive can have. And an archived issue
whose defect comes back un-archives itself, folder included, on the save that
reopens it. Archived cards carry a restore button for everything else.

## Safety defaults

- Targets must be localhost unless `--allow-remote` is passed explicitly.
- lookout never starts services; a down target prints the project's
  `startHint` and exits.
- Judging runs `claude -p` with read-only tool access, cwd-pinned to the
  evidence directory.

## Per-project config

`lookout.config.ts` sits at the project root, beside `package.json`. It is a
TypeScript module (the CLI runs under bun, so recipes are real functions)
default-exporting a `LookoutConfig`. Everything below is optional except
`targets`.

lookout writes and maintains this file. `lookout init` creates it; a verb that
needs a config and finds none creates it too, seeded from `--url` when the run
gave one and left as a template to edit when it did not. A project still
holding the older `.lookout/config.ts` keeps working: the first run that finds
one moves it to the root and repoints the `rubric` and route `design` paths
inside it, since those resolve relative to the config file. `--config <path>`
still overrides the search entirely, and `.js`, `.mjs` and `.json` are read as
well (a JSON config cannot carry recipes).

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

  // Navigation discovery: hand-written states cover what you thought of;
  // this covers the rest. See "Navigation discovery" below before enabling:
  // lookout will click destructive controls too.
  navigation: {
    enabled: true,
    maxStatesPerRoute: 5,     // judged interaction states per route
    maxChecksPerRoute: 8,     // link-verification clicks (no judging cost)
    exclude: ["Sign out"],    // CSS selectors or accessible-name substrings
  },

  // Project judging rules, layered into the judge-core skill in every judge
  // prompt. Editing this file re-judges whatever it could have changed: the
  // ledger is keyed on the composed prompt itself, so nothing has to be bumped
  // by hand. An optional `rubricVersion: N` header is still read, and shows up
  // in the key for anyone reading ledger.json.
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

### Navigation discovery

Hand-written state recipes photograph the interactions you thought to write
down. Navigation discovery covers the rest of a route: with
`navigation.enabled`, every capture harvests the route's visible buttons,
links, and CTAs, and `check` asks the `plan-navigation` skill to curate them
into an interaction plan. The plan is cached in `.lookout/navigation.json`
and keyed by a signature of the route's affordances, so the model is spent
only when a route's controls actually change (at most ten routes per run;
`--navigate` forces a re-plan, `--no-navigation` skips discovery for a run).
Capture then executes the plan deterministically: overlays and in-page
changes become states judged like any other, a click that leaves the route
photographs the destination page as a state of this route, and links to
routes already in the config are merely clicked and verified, filing
`dead-interaction` or error findings when they do not work. Each state is a
view group of its own, so every planned state costs one more judge batch per
run when its pixels change.

**lookout clicks everything it plans, destructive controls included.** Risk
classification orders the clicks (risky last, session-enders last of all,
with the target's `signIn` re-run afterward); it does not prevent them.
Point targets at a disposable environment, and put anything untouchable in
`navigation.exclude`. A failed synthesized interaction never kills the
route: it files a `capture-error` finding on the rest shot and the capture
moves on. Discovered same-origin pages that are not in the config are
reported as coverage suggestions; lookout never edits the config itself.

### Skills: where lookout's AI behaviour lives

Every AI capability is an instruction file, not a string in the binary. They
ship in the standard Agent Skill layout, one directory each:

```
skills/
  judge-core/           SKILL.md + rubric.md: the shared judging core: bands,
                        severity ladder, regions, procedure, the output contract
  judge-integrity/      SKILL.md: render failures, broken states, missing anatomy
  judge-geometry/       SKILL.md: overflow, alignment, spacing, responsive
  judge-visibility/     SKILL.md: color-scheme, contrast, visually evident a11y
  judge-text/           SKILL.md: typography and broken copy
  judge-craft/          SKILL.md: hierarchy, composition, consistency
  judge-design-parity/  SKILL.md: divergence from a design hand-off; judges only
                        design-bearing views. handoff.md: how to compare
  refute-finding/       SKILL.md: the adversarial pass that kills false findings
  verify-acceptance/    SKILL.md: ruling on a ticket's criteria from evidence alone
  fact-check/           SKILL.md: answering one question from screenshots
  design-placement/     SKILL.md: where a defect belongs, in a project with a kit
  kit-conformance/      SKILL.md: whether the application is built out of that kit
  plan-navigation/      SKILL.md: which of a route's affordances to actuate, what
                        to name each state, and what only needs verifying
```

A skill carries the whole prompt shape, placeholders and all. lookout supplies
only data: the shot manifest, the paths, the question. Each declares
`{{amendments}}`, the slot where a project's own layer lands.

The visual judge is six specialists, each judging every view group in its own
call. The closed category vocabulary is partitioned across them (the registry
in `src/judge/panels.ts` is the single source of that partition), and each
judge's prompt is assembled from the `judge-core` skill (severity ladder, the
judging procedure, the universal never-file list), that panel's own vocabulary
and layer, then this project's `.lookout/skills/` layers, its `rubric` file,
and its `neverFile` lines. A finding outside the vocabulary, or outside the
filing panel's own lane, is rejected at ingestion, so project extensions
refine judgment; they cannot invent new taxonomies. Every finding states which
judge filed it, and `--panels` narrows a run to named judges.

The ledger keys one entry per view group PER PANEL, on the composed prompt
itself, judging and refuting instructions together: amending one specialist, a
project rubric or a `neverFile` line invalidates exactly the cached verdicts
it could have changed, and the other panels' rulings stand. That covers the
refuting skill too, because what the ledger stores is what survived it.

### What the judge rules on

The rubric sorts everything it could say into three bands, because the useful
question is not "is this good" but "is this mine to call".

**Execution defects** are filed without argument: broken, illegible,
overlapping, clipped, unrendered.

**Design quality** is filed too, on one condition: the finding must name the
principle it breaks and what that costs the person using the screen. "The card's
title, metadata and body are all one size and weight, so the eye has no entry
point" is a finding; "the card looks bad" is not. This is the band a model is
actually strongest in, because it is a judgment about the whole rather than a
measurement, and the citation requirement is what keeps it falsifiable enough to
verify and to write acceptance criteria for.

**Product and brand decisions** are left alone: which blue, which typeface, how
round the corners, how dense the information, the voice of the copy. lookout
rules on what a decision does in context (a brand colour that leaves text
unreadable is a contrast defect) and never on the decision.

Two things follow from this that are worth knowing. The judge is told it cannot
measure, because it is reading an image: it files a geometry finding only when
the deviation is visible without looking for it, and never quotes a pixel value
it did not read off the screen. And it is told not to rule on anything a still
image cannot show, such as focus order, which is what the deterministic axe pass
and the console checks are for.

### Skills that improve themselves

```bash
lookout skills list               # what lookout knows how to judge, and what this project has amended
lookout skills freeze             # freeze the settled verdicts into a regression set
lookout skills improve            # learn from this project's runs, and keep it only if the set holds
lookout skills replay             # judge the frozen set with the skills as they stand
```

`improve` reads signals lookout already records: findings the adversarial
verifier refuted, findings a person adjudicated by-design and wrote a reason
for, defects that survived every attempt, acceptance criteria that could not be
decided from a screenshot, and replies that failed the output contract. It
writes the amendment that would have prevented the most of them into this
project's layer. Each pass sees only signals no earlier pass was shown
(`.lookout/skills/signals-seen.json` is the watermark;
`--all-signals` replays everything), so the same evidence never pays twice.

You rarely run it by hand: `lookout check` and `lookout verify-fix` run it
themselves once enough new evidence accumulates. Three new signals, or a
single new by-design adjudication, and the run ends by learning from them.
Decline it with `--no-improve` for one run or `learn: { auto: false }` in the
config for good; `learn.threshold` and `learn.cooldownHours` (default 3 and
24) tune it, and CI environments never auto-learn. When nothing frozen could
grade an amendment, the automatic path spends nothing; a manual run needs
`--propose` to pay for an outcome that can only be an unapplied `PROPOSED.md`.

It applies automatically, and what makes that safe is the gate. `.lookout/regression/`
holds screenshots whose verdicts were settled when the pixels were fresh: what a
person ruled intentional, and what the verifier confirmed. The candidate is
replayed over them, and an amendment that re-files a suppressed finding or loses
a confirmed one is rolled back, with the attempt and its violations written to
`.lookout/skills/history.jsonl`. An amendment nothing can grade, because the set
is empty or its pixels are not on this machine, is written to `PROPOSED.md`
instead of being applied.

The manifest survives evidence cleans and the frozen pixels may not;
`lookout skills freeze` rebuilds them from the evidence store.

### Healing itself

```bash
lookout self-heal
```

Failures lookout hits are appended to `~/.lookout/incidents.jsonl`, pooled
across every project on the machine: crashes, operator errors, judge replies
that could not be parsed, findings rejected at ingestion. (The log compacts
entries older than 90 days once it outgrows 2000 lines; nothing else ever
rewrites it.) `self-heal` groups them and picks the one group the run works
on itself: the heaviest active pressure in the last 30 days, where a group
healed before that came back outranks everything, and one with two reverted
attempts on record waits for a person. It fixes that group's cause in
lookout's own checkout, and is not believed about any of it. Committed heals
are marked in `~/.lookout/heals.jsonl`, so a settled group stops being
offered. This verb never runs itself: it edits the code that does the
judging, and starting it stays a person's deliberate act.

The subprocess may read and edit inside the checkout and may not run a single
command. lookout runs `tsc --noEmit`, `eslint`, `bun test` and the build itself,
plus a replay of frozen regression sets from up to two recent projects that
hold one (`--project` names one explicitly); when no project on the machine
can grade the judge, the commit says so. A reply that breaks the report
contract forfeits its edits outright: reverted, kept with the raw reply for
a person, recorded as an incident. Any gate failing reverts everything, keeps
the diff and the gate output under `~/.lookout/self-heal/<stamp>/`, and
records the rollback as an incident.
Every gate passing commits the change alone with a patch changeset, and does not
push: a local commit is one `git revert` away.

It refuses to run on an installed package (no source, no repository), over a
dirty checkout, or while another heal holds the lock. What it has done, and
what it tried and lost, is on the second area of `lookout ui`.

### Where things land

The config is the one file meant to be shared, so it is the one file outside
this directory: `lookout.config.ts` sits at the project root and is committed
like any other tool's config.

The whole of `.lookout/` is lookout's working state, and `lookout init` keeps
it out of git (`.lookout/` in the project's `.gitignore`). It is per-checkout:
it does not follow the repo to another machine, and deleting the directory
re-rolls every issue id.

```
lookout.config.ts  the project's targets and recipes (at the root, in git)

.lookout/
  backlog.json     adjudicated findings (managed via `lookout backlog`)
  BACKLOG.md       generated report (regen via `lookout backlog regen`)
  ledger.json      judge verdict cache
  design-system.json  what the project is built from, cached
  conformance.json    the source reading pass, cached
  issues/<id>/     one folder per issue, named by its six-digit id:
                     Issue.md, Issue.json, state.json, frames.json, img/pre/,
                     img/post/ (the frames either side of a fix, frozen when
                     the issue is filed and when a fix is ruled)
  issues/archive/<id>/  issues filed away, same folder, moved whole
  skills/          this project's layer over lookout's shipped skills,
                     plus signals-seen.json, the learned-from watermark
  evidence/        screenshots + capture-report.json + judge-report.json
```

### The fix loop (for agents)

lookout never edits code. The loop it is built for:

1. `lookout check` in the target repo: findings merge into the backlog.
2. Fix the code in that repo, per that repo's own conventions.
3. Optionally, `lookout check --targets x --routes /y` to see what the judge
   says now; unchanged pixels stay ledger-cached. This does not move what the
   ruling in the next step is measured against.
4. `lookout verify-fix --issue <id> --commit <sha> --note "<root cause>"` is
   the only thing that closes a finding. It rules on that issue alone: a fix
   that clears the defect and causes another one passes, and the new defect is
   filed as its own numbered issue with a note saying which fix surfaced it.
   A ruling that does not pass spends an attempt; what it saw is printed and
   written into the issue's `Issue.md` under "What has been tried".
5. `lookout backlog set <fingerprint> --status fixed --commit <sha>`; use
   `--status by-design --reason "..."` for intended behavior (suppressed in
   every later merge) and `--status blocked --reason "..."` after repeated
   failed attempts.
6. `lookout backlog check` as the gate: schema, mandatory reasons, missing
   issue ids, markdown freshness, and drift detection all fail loud. A
   finding whose problem is written for one reader is a warning; `--strict`
   makes warnings fail too.

## License

MIT. See [LICENSE](LICENSE). The grant covers this repository as well as the
package published to npm; it used to cover the published package alone.
