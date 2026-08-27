# @nannier-com/lookout

## 0.18.0

### Minor Changes

- 7314dc7: A fix that causes a different defect no longer regresses the issue it fixed.

  New user-visible behaviour, which is what makes this a minor: `verify-fix` now
  rules on one question, is this issue's defect gone, and files anything else it
  finds as its own numbered issue. The new issue carries `causedBy`: which issue's
  fix was in flight, at which commit, in which run. The issue that surfaced it
  gets a line of history saying so, and nothing else.

  What this replaces was actively wrong. A new critical or high finding on changed
  pixels came back as the verdict `regressed` for the issue being verified, even
  when its own findings were completely gone. Its findings stayed open, every
  member's `fixAttempts` incremented, and since the default cap is two attempts, a
  second occurrence blocked the issue and wrote a mandatory reason asserting "the
  defect persists" about a defect that had been fixed two rounds earlier.

  `regressed` is gone from the verdict union and from the board's statuses. A
  finding with the same fingerprint reappearing after being marked fixed still
  reopens, as it always did: that is the same defect coming back, which is a
  different thing from a fix causing a new one.

  Exit codes are unchanged, so a pass is still 0 even when the run filed new
  issues. They are named in the ruling and carried as `spawned` under `--json`;
  they are separate work, and dispatching them is a separate decision.

## 0.17.0

### Minor Changes

- c1f774a: Every issue now has a six-digit number and a folder of its own.

  New user-visible capability, which is what makes this a minor: `.lookout/issues/<id>/`
  holds everything about one defect. Its record (`issue.json`), its document
  (`ISSUE.md`), the screenshots it was filed against (`shots/`), what the last
  re-check saw (`recheck/`), and every attempt made on it (`state.json`). Opening
  that folder answers "what is this" without the tool, the backlog, or the
  conversation that produced it.

  The id is drawn at random from 100000 to 999999 and minted once, the first time
  a root cause is seen. Clustering still decides what groups with what: that is
  the derived key, and it still has to be recomputable so a defect re-found next
  week merges instead of duplicating. The number is the name people use. The
  registry lives in `backlog.json`, which is committed, because an id that cannot
  be recomputed and is not written down is an id that comes back different and
  orphans the folder named after it. Nothing is ever pruned or reused.

  `verify-fix --cluster app--color-scheme--dark-mode` is now
  `verify-fix --issue 418203`. The old flag is gone rather than aliased: it named
  an identity that is now internal, and a dead alias for it would be one more
  thing to explain. Everything else adjusts on its own, including backlogs written
  before ids existed, which are repaired and rewritten the first time any verb
  loads them. `lookout backlog check` fails on a root cause with no id.

  `BACKLOG.md` gained an `issue` column, and its headline counts issues as well as
  findings: the number is the thing people quote, so it belongs on the report
  people read.

  Attempt history moved with it: `.lookout/evidence/fix/<key>.state.json` is now
  `.lookout/issues/<id>/state.json`, which means it survives an evidence clean.
  Add `.lookout/issues/*/shots/` and `.lookout/issues/*/recheck/` to .gitignore;
  the record beside them is worth committing, the pixels are not.

## 0.16.0

### Minor Changes

- 0c84257: Every AI capability lookout has is now a skill file, and a project can amend any
  of them.

  New user-visible capability, which is what makes this a minor: a project can put
  its own `.lookout/skills/<name>/SKILL.md` next to its config, and lookout layers
  it over the shipped skill at the slot that skill declares. That is a second
  extension point beside `rubric` and `neverFile`, and unlike those it reaches the
  refuter, the acceptance verifier, and the fact-checker rather than the judge
  alone.

  The four capabilities (`visual-judge`, `refute-finding`, `verify-acceptance`,
  `fact-check`) ship as `skills/<name>/SKILL.md` in the standard Agent Skill
  layout, each carrying the whole prompt shape with placeholders. lookout supplies
  data only: the shot manifest, the paths, the question. Nothing about what the
  model is asked to think lives in TypeScript any more, and any harness that reads
  skills can read lookout's.

  `rubric/BASE.md` moved to `skills/visual-judge/rubric.md` unchanged; the
  `rubricVersion` header it carried became the skill's `version`, and the ledger
  key is now `<groupHash>@v<judgeSkillVersion>@<model>`. Cached judge verdicts fall
  out of cache once on upgrade, which is the intended behaviour whenever the rules
  change. `config.rubric` and `config.neverFile` keep working exactly as before.

## 0.15.1

### Patch Changes

- e32b2da: Say when the build is stale, and put a command in the handoff that actually runs.

  Running lookout out of its own repository with a build older than the source is
  invisible: the code runs, it just is not the code you wrote, and every symptom
  points somewhere else. It cost real time. Every verb now checks, when there is a
  `src` directory beside `dist`, whether any source file is newer than the build,
  and says so plainly, including the part people forget: a server already running
  holds the old code in memory until it is restarted. Published installs ship
  `dist` alone, so it never fires for them.

  The handoff document told whoever opened it to run `lookout verify-fix`. That
  only works if `lookout` is on PATH, and in a source checkout it is not. It now
  resolves the CLI it is actually running from and writes a command that works,
  falling back to the bare name only when neither is usable.

## 0.15.0

### Minor Changes

- 4d45b05: A run stops at the first route with issues, and files every issue on it.

  The previous shape narrowed to a single worst issue at merge time. It held, but
  it threw away real findings lookout had already captured and judged: a live run
  filed one console error and discarded three other defects, two of them scheme
  mismatches, which then had to be paid for again on the next run.

  Scoping replaces narrowing. `--first` walks routes in config order, stops at the
  first one that turns anything up, and files all of it. Nothing lookout did is
  discarded, and nothing is claimed about the routes it never looked at.

  That deleted more than it added. Gone: the finding-count limit and `--limit`,
  the forced-serial judging that limit needed, the merge-time narrowing and the
  "seen but not filed" accounting, and the optimisation that skipped the judge
  when the capture had already found something. That last one was right when the
  answer was one issue and wrong now, because a route's issues include the ones
  only the judge can see.

  The page says how far the walk got rather than how much it dropped: stopped at
  this route, after looking at N of M, fix these and run again for the next.

## 0.14.1

### Patch Changes

- bfa505e: The launch control is the tool's mark with a play beside it, and dropped
  findings are no longer invisible.

  Each issue card carried the words "open in Claude Code", repeated on every card
  and restating what the navbar toggle already says. It is now the selected tool's
  own mark next to a green play triangle: the card shows what it opens in rather
  than spelling it out, and switching the toggle re-marks every card. The name
  stays in `aria-label` and the tooltip, and the control pulses while opening
  instead of swapping its text, which would have deleted the marks.

  The page also says what a run saw and did not file. A `--first` run records one
  issue and drops the rest, and those were real findings: on a live project a
  single run filed one console error and dropped three other defects, including
  two scheme mismatches, with nothing on the page admitting they existed. There is
  now a line above the board saying how many were seen and not filed, and that
  running again picks up the next one.

  The evidence heading reads **Where lookout saw it** rather than "What lookout
  saw". An issue lists the screenshots the defect was actually observed on, which
  is usually fewer than the captures of that route, and the old wording invited
  the reasonable question of why one file was named when six sat in the folder.

## 0.14.0

### Minor Changes

- ecd164a: `--first` walks one route at a time, and Findings is folded into Issues.

  Narrowing at merge time was too late to stop the thing that actually hurt: a
  run still captured every route across every form factor and scheme before
  judging anything. On a thirteen-route project that is seventy-eight screenshots
  and several minutes to answer a question the first route usually settles.

  `--first` now walks the application a route at a time, in config order, and
  stops at the first route that turns something up. Each stop is a handful of
  screenshots rather than the whole application, and if the capture already found
  something the judge is skipped entirely, because deterministic findings are free
  and certain. Measured on a real project: six screenshots, one issue, stopped
  after one of thirteen routes, seven seconds, nothing spent on the judge. The
  previous behaviour had reached forty-eight screenshots before it was stopped.

  A run that finds nothing still costs a full sweep and says so, and one that
  stops early says how many routes it looked at, because "one issue" would
  otherwise read as a clean bill of health for an application mostly never seen.

  The Findings section is gone. It showed the same screenshot and the same
  severity as the issue above it, next to a pointer back to that issue: two cards
  for one thing. The only content it carried that an issue did not was the judge's
  own words, so those moved onto the issue card as a **What is wrong** block
  listing every defect grouped under that root cause. Severity counts issues now,
  which also makes the filter numbers mean the cards under them.

## 0.13.2

### Patch Changes

- bc9a80e: `--first` really does record one issue now.

  It stopped the judge after one _finding_, which is a different thing and did not
  hold anyway. Three ways a single click could still file fifteen issues:

  Two batches judged in parallel, so the second one's findings landed after the
  first had already met the limit, having been paid for only to be discarded.
  Judging is serial whenever a limit is set.

  One batch is a view group and can return several findings at once, so the limit
  was met and overshot in the same step. And the deterministic findings, which are
  free and never went near the judge, were merged in full regardless of any of it:
  a run could stop at one judged finding and still file every accessibility
  violation in the capture.

  Narrowing now happens once, across both channels, at the point findings are
  written to the backlog. One issue means one cluster, not one finding, so a root
  cause seen on six screenshots stays whole: splitting it would hand over a third
  of a defect. The worst severity wins, ties go to the cluster covering the most
  screenshots.

  Two things follow. If the capture already found something, `--first` skips
  judging altogether, because deterministic findings are free and certain and
  judging on would spend minutes and money on findings about to be dropped. And
  the run says how many findings it saw but did not file, since silently
  discarding real findings would report the application as healthier than it is.

## 0.13.1

### Patch Changes

- 7c7c45c: The Find and fix control is a green play button.

  A round green button with a play triangle, rather than a rectangle with words
  in it: the whole control means "go", so it reads faster as a shape. Its name
  lives in `aria-label` and the tooltip, which also names the repository it will
  check and says that the run stops at the first issue.

  While a check is running the triangle gives way to a ring turning around it, so
  the same control shows the run is live without moving or resizing. The green is
  a token in both schemes, darker in light and brighter in dark, and distinct from
  the green used for a finding that passed.

## 0.13.0

### Minor Changes

- 29287db: Run a check from the page, and tell whoever opens an issue what the rules are.

  A **Find and fix** button sits under the tool toggle. It runs one check against
  the project the page is pointed at, stopping at the first issue: the loop it
  serves is find one, fix one, verify it, and judging on for another eight minutes
  to hand back twenty-six more answers a question nobody has asked yet. `lookout
check --first` does the same from a terminal, and `--limit <n>` stops after n.
  A run that stopped early says so, in the log and on the page, because "1
  finding" would otherwise read as a clean bill of health for an application that
  was mostly never looked at.

  The button knows when it cannot work. With no `.lookout/config.ts` where the
  page is pointed, it reads **Choose a repo** and opens a native folder picker
  first; a browser cannot hand back a real filesystem path, so the local server
  asks the operating system instead. `lookout ui` is therefore no longer bound for
  life to the directory it was launched in: point it at another repository and it
  serves that one, board and all.

  Handoffs now name the rules that govern the work, global first, then the
  workspace's, then the repository's, each by absolute path, and say to read them
  before editing anything. Claude Code loads its own global file; nothing else
  does, and the whole point of the tool toggle is that a handoff may not be opened
  in Claude Code. Discovery covers `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and
  the equivalents for the other harnesses.

## 0.12.0

### Minor Changes

- 0a27807: The tool toggle shows marks instead of words, and contact sheets are gone.

  The navbar toggle is now two logo marks rather than two labels: a burst for
  Claude Code, a six-lobed knot for Codex, each with the tool's name as its
  accessible label and tooltip. They are lookout's own drawings, not the vendors'
  official logos, which are trademarks lookout has no copy of and would only
  reproduce badly from memory. A project that wants the real thing drops an SVG at
  `.lookout/logos/claude-code.svg` or `.lookout/logos/codex.svg` and lookout uses
  that instead; a file that is not a lone `<svg>`, or that carries script, is
  ignored, because the markup goes straight into the page.

  Contact sheets are removed: `buildContactSheet`, the per-issue sheets, the
  run-level `contact-sheet.png`, the navbar link, the sheet tile on every card,
  and the sheet line in handoff documents and `lookout status`. Compositing every
  capture into one image existed so that a fix session could see a whole defect in
  a single read. Nothing works that way now: the UI shows the screenshots inline,
  and the handoff lists them individually by absolute path. The one thing lost is
  that an agent reading a handoff opens N images rather than one.

## 0.11.0

### Minor Changes

- 4b6a4e2: Open an issue in Claude Code or Codex, from the card.

  Every issue card has a launch button, and the navbar carries a toggle choosing
  which tool it opens: Claude Code or Codex, remembered per browser so nobody
  re-picks it every visit. A tool whose binary is not on PATH is shown greyed
  rather than hidden, and choosing it still works: the handoff is written and the
  exact command handed back to run by hand, because a button that silently does
  nothing is worse than one that tells you why.

  Clicking writes a handoff document gathering everything scattered across the
  backlog, the evidence directory and the state file into one file: what is wrong
  in the judge's own words, expected against observed, every screenshot by
  absolute path, the contact sheet, the repository, and how to ask lookout to rule
  when the change is made. On macOS it then opens that document in the chosen tool
  in a new terminal.

  This is not lookout dispatching work again, and the document is written so it
  cannot read as such: it names no subagent, sets no protocol, and asks for
  nothing back. It runs because a person clicked, and it says so in the text. The
  one instruction it carries is the only one lookout is entitled to give, which is
  not to take your own word for whether the defect is gone.

## 0.10.0

### Minor Changes

- 51a04d7: lookout finds issues and documents them. It no longer dispatches work.

  It used to render every root cause as an executable prompt and tell the calling
  session to spawn a named subagent on it, then track those sessions as they
  worked. That was lookout deciding who does what, which is not its job. All of it
  is gone: `check --auto`, the dispatch streamer, the fix briefs, `PLAN.json`,
  `backlog plan`, the spawn instructions in the protocol, and the `lookout agent`
  verb that tracked the sessions.

  What lookout does now is state plainly in `lookout protocol`: it captures what
  an application renders, judges the pixels, writes down what is wrong, and rules
  on whether a defect is gone when you ask it to. What to do about a finding is
  your call.

  `verify-fix` stays, because verifying is not fixing. It remains the only thing
  that closes a finding, and the only thing that can say a defect is actually
  gone, which is the oracle property the whole design rests on.

  `lookout ui` is rebuilt around that. It shows **issues**, not fix sessions: one
  issue is one root cause, carrying its severity, the routes it appears on, the
  screenshots it was filed against, a contact sheet showing them together, and
  lookout's own record of it, oldest first, from the day it was filed through
  every ruling. While a `verify-fix` is running, that record tails live, the way
  a log does.

  Every path on the page is absolute, because the point of the page is handing an
  issue to somebody who then has to go and open those files. Each card ends with
  an "Evidence on disk" block listing its contact sheet and screenshots in full,
  selectable form, and `lookout status` prints them the same way.

  The filters moved into the navbar, where they read as navigation rather than as
  statistics: open, blocked, done and archived narrow the issues, the four
  severities narrow the findings, and a clear control appears beside them while a
  filter is on.

## 0.9.0

### Minor Changes

- 1dba50e: Stop filing blocked work under a green "settled" heading, and keep done and
  archived work reachable.

  "Settled" counted `passed` and `blocked` together and coloured the total green.
  Blocked does not mean settled: `verify-fix` rules a cluster blocked when it has
  exhausted its attempts and lookout stops dispatching it, so the defect is still
  there and now needs a person. On a real project that put ten unfixed defects
  under a green success number. Blocked is now its own count, coloured as the
  problem it is, and its tile says what it means.

  The board also carries the two states it used to drop entirely. A finding marked
  `fixed` reads as **done**, one marked `by-design` reads as **archived**, and both
  have their own tile. Unfiltered, the page shows what still needs doing; clicking
  done or archived brings the settled work back into view. Cluster status follows
  the same precedence: anything still open is live work, then blocked, then done,
  then archived.

  The severity numbers count outstanding work only, so a critical somebody already
  fixed stops inflating "critical". They are filter controls now, and a filter is
  only useful if its number means what it says.

  A clear control sits at the end of the tile row whenever a filter is on, next to
  the tiles that set it, alongside the existing one in the filter bar and the
  Escape key.

## 0.8.0

### Minor Changes

- 56991ed: Click a headline number to see the work it counts.

  The numbers across the top of `lookout ui` were the fastest way to find out
  there were seventeen clusters awaiting a session, and no way at all to see
  which seventeen. They are buttons now. Clicking "awaiting a session", "working",
  "reported back" or "settled" narrows the board to those fix sessions; clicking
  "critical", "high", "medium" or "low" narrows to that severity. Both sections
  narrow together, so they always describe the same slice of work: under a state
  filter the findings shown are the ones belonging to the sessions on screen.

  The click scrolls to the section it just narrowed and flashes it, the active
  tile is marked, a bar names what is being shown, and clicking the same tile
  again, pressing the bar's button, or hitting Escape puts everything back. A
  number that stands for nothing is not a control, so "shots" and "batches" stay
  inert, and a count of zero is disabled rather than offering an empty view.

  Making them filters exposed that they were counting the wrong thing. The
  findings section and its severity numbers were still built from `finding`
  events, so they had the bug the board was just fixed for: the log is truncated
  by every capture, and a project with fifty-three outstanding findings displayed
  two. Findings now come from the backlog, the same durable source as the board,
  which is also why they can name the cluster that owns them: each one carries its
  cluster id, so a finding card links to the session working it rather than
  leaving you to pair a category and a route by eye. Blocked findings are shown
  and marked as such instead of being silently dropped.

## 0.7.0

### Minor Changes

- 9aa09d7: The board survives a restart, because outstanding work is state, not narration.

  The board was a fold over `events.jsonl` alone. That file is narration, and
  every `check` or `capture` run truncates it. So the moment anything re-captured,
  or the machine was restarted, a project with thirty-seven open findings and
  eighteen briefs written showed "nothing dispatched yet", and every record of who
  had worked what went with it. Real numbers from a real project: the board read
  zero while the backlog held 37 open and 16 blocked findings.

  The durable answer was always sitting next to it. `backlog.json` is the
  adjudicated record of every finding, clustering is deterministic, and each
  cluster's attempts and fix sessions live in `fix/<id>.state.json`. So the board
  is now built from those, and the event log is demoted to what it actually is: an
  overlay saying what is happening this second on top of a board that exists
  whether or not a run is in flight. `lookout ui`, `lookout status` and `lookout
agent list` all read the same rebuilt board.

  The consequences, all of which were broken before:

  Blocked work stays on the board instead of vanishing, because a cluster that
  exhausted its attempts is exactly what somebody looking at this needs to see.

  A fix session's history outlives the run that recorded it. Its notes, its
  commit, and lookout's ruling are reconstructed from the state file, so a card
  still says who fixed what and what the judge said days later.

  Disk is authoritative for what the work is; the log only adds what disk cannot
  know. A re-judge in flight is read from the events directly rather than from the
  fold, because a log truncated by a plain `check` carries no dispatches for the
  fold to attach to. A dispatch event can no longer resurrect work the backlog has
  settled.

  Two smaller fixes fell out. A cluster is dated by the earliest thing recorded
  about it rather than by its brief's mtime, since `verify-fix` rewrites the brief
  when it hands a cluster back, which pushed the dispatch to after the session
  that had already worked it. And work that has never been sent to anybody now
  says "not dispatched yet" instead of dating itself to 1970 and rendering
  "dispatched 496604h06m".

  The page holds its rebuilt board until `backlog.json`, the event log or the fix
  directory actually changes on disk, so polling twice a second does not re-read a
  hundred kilobytes each time.

## 0.6.0

### Minor Changes

- a633506: Show what each fix session is actually doing, line by line, while it does it.

  The capability, and the reason this is a minor: every board entry now carries a
  `timeline`, the cluster's running account of itself, oldest first. Dispatch, the
  session picking it up, every progress note that session reported, its hand-back
  with the commit, lookout re-judging, and the verdict. It is on `lookout status
--json` and `lookout agent list --json`, and `lookout ui` renders it as a live
  feed on every card, tailing the newest line while a session is still working.

  A status word says where a session got to. This says what it has been doing,
  which is the question somebody watching a dozen sessions actually has. The
  briefs now ask for it: a fix session is told to narrate each meaningful step
  with `lookout agent note`, in one short concrete line, after it has looked at
  the screenshots, when it knows the root cause, before a substantial edit, and
  when it commits. Those lines claim nothing and close nothing; `verify-fix` is
  still the only thing that rules.

  Three bugs fixed along the way, all of which made the page look unstable.

  `lookout agent` modelled a report as a run. Reporting is instantaneous and has
  no end to emit, so the log was left claiming a run was in flight forever, and
  the header showed "agent note app--render-failure--..." where the phase goes.
  Reports now attach to the board rather than opening a run of their own.

  A run that was killed never emits `run-end`, so the log said running forever:
  `lookout ui` showed a pulsing live dot and a clock climbing past five hours over
  an empty board, and `lookout status` reported RUNNING for a process that died
  hours earlier. lookout cannot see a process die, so silence is the only evidence
  available: past ten minutes with nothing said, both now say stalled and how long
  it has been quiet. The fold exposes `lastEventAt` and stays pure; the threshold
  lives with the callers.

  The page rebuilt its stat row on every 1.5-second poll, because that one section
  was assigned directly instead of going through the repaint guard every other
  section used.

  Two sections are gone. The activity log is redundant now that each card carries
  its own feed, and the grid of captures no cluster was filed against answered a
  question this page does not ask; the run's contact sheet is one image with every
  capture on it, and is now a single link in the header instead.

## 0.5.1

### Patch Changes

- 62f1f75: Give every finding the screenshot it was filed against.

  A finding is a claim about one screenshot, and `lookout ui` showed everything
  except that screenshot: a title, a category and three words of context, with the
  evidence for the claim living somewhere else on the page. The finding event was
  already carrying the path, route, form factor, scheme, the judge's full prose and
  whether an adversarial pass had verified it, and all of it was being discarded at
  render time.

  Each finding is now a card with its own thumbnail, the judge's reasoning in full,
  and, matched back through the dispatched cluster's screenshots, which fix session
  owns the defect and what state that session is in. So a reader can go from
  "dark-scheme captures render the same light surfaces" to the capture that proves
  it, and on to the agent currently fixing it, without leaving the page.

  Two ordering bugs fell out of building it. Findings sorted reverse
  chronologically, which put a low-severity nit above three criticals on a page
  whose job is triage; they now sort worst first, newest first within a severity.
  And the section's repaint signature keyed on the number of findings alone, so a
  re-judged finding kept showing its old prose until the count happened to change.
  It now keys on what the cards actually draw.

## 0.5.0

### Minor Changes

- 30dc916: Show which fix session is working which cluster, live, with that cluster's own
  screenshots.

  New capability, and the reason this is a minor: a `lookout agent` verb. lookout
  dispatches work into child sessions it cannot see, so between a dispatch and the
  verdict that closes it, it had no idea whether a cluster was untouched or had
  had an agent on it for twenty minutes. Both rendered as the same words,
  "awaiting a fix session". The orchestrating run now says so: `lookout agent
start --cluster <id> --name "<label>"` when it spawns a session, `agent note`
  as a heartbeat, and `agent done --cluster <id> --commit <sha>` when it replies.
  `agent list` prints the board. None of it adjudicates anything; a session saying
  it is done is still only a claim, and `verify-fix` remains the only thing that
  closes a finding. Reporting is optional by construction, and a harness that
  never calls it leaves its cards at `queued`, which is exactly what lookout knew
  before.

  Two bugs behind that, both structural. The event log truncated on every run, and
  `verify-fix` opened it the same way `check` does, so ruling on one cluster
  erased the dispatches of every other cluster and every session working them: the
  board could not accumulate at all. Runs that report against a board now join it
  instead of starting one, and the log is pruned rather than wiped once it grows.
  And a dispatch carried only a count of its screenshots, never their paths, even
  though the cluster's contact sheet had just been composited and thrown away. It
  now carries both, so a card can show the evidence its own session is looking at.

  `lookout ui` is rebuilt around that. It was a page-level report: one flat list of
  identical dispatch rows, and below it a single undifferentiated grid of every
  capture in the run, which answered "what did lookout see" but never "who is
  working on what". It is now a board of fix sessions. Each card carries its
  status, who is on it and for how long on a ticking clock, its severity, routes
  and attempt, the screenshots the defect was filed against, its contact sheet,
  and, once a fix is claimed, what `verify-fix` saw afterwards. Captures no
  cluster was filed against are collapsed out of the way. `lookout status` gained
  the same board, so an agent polling it sees what a person watching sees.

## 0.4.3

### Patch Changes

- 443f0dd: Rule on evidence that moved, not on how the judge phrased itself today.

  The judge is not deterministic: re-judging identical pixels can surface a
  finding it did not mention last time and drop one it did. `verify-fix` was
  treating both as facts about the fix, which broke it in two directions. A live
  run with no fix applied at all came back `regressed`, blaming a session for two
  findings it could not have caused, which burns an attempt and eventually blocks
  a cluster over defects nobody touched. The mirror image was worse: a cluster
  could PASS on unchanged pixels purely because the judge happened not to mention
  its defect that time, letting variance alone close a real finding.

  Pixel hashes are deterministic, so the ruling now turns on them. A finding only
  counts as a regression if it appears on a screenshot whose pixels actually
  changed, and nothing may pass while every screenshot in scope is byte-identical
  to the previous run: that verdict is now `still-open`, with a note saying no
  edit reached the rendered output and naming the usual causes. The rule is
  extracted to `src/fix/rule.ts` as a pure function so each of these cases is
  stated in a test.

## 0.4.2

### Patch Changes

- 749720f: Judge one view group per call by default (batch size 6, was 10).

  A view group, one route and state across its form factors and schemes, is
  already the unit the rubric compares within, so a larger batch buys the judge no
  context it can use. It does hold every finding in the batch hostage until the
  whole batch returns: on full-page screenshots that ran to several silent
  minutes, which defeats the point of streaming. `--batch-size` still overrides.

## 0.4.1

### Patch Changes

- 36a5e0e: Fix `verify-fix` passing a deterministic cluster that never got fixed.

  The ruling compared the cluster against freshly judged findings only. Rule
  violations come back from capture rather than from the judge, so an
  accessibility cluster (every `axe-*` finding) matched nothing on re-check and
  was marked fixed with its violations still firing, which is the one outcome the
  oracle exists to prevent. It now compares against both channels.

## 0.4.0

### Minor Changes

- 3bbebd9: Feed the session while the run is still going, show a person what is happening,
  and carry the operating contract in the tool rather than in one vendor's plugin.

  New user-visible capability across three fronts.

  **Live feedback.** A run takes minutes and a subprocess's stdout does not reach
  its caller until it exits, so lookout now narrates to
  `.lookout/evidence/events.jsonl` as it goes. `lookout status` folds that into
  "what is happening right now" for an agent to poll (exit 1 while a run is in
  flight), and `lookout ui` serves a local page that renders the same log live,
  with screenshot thumbnails, findings as they are confirmed, dispatched clusters
  and their verdicts. Both read the log, so either can watch a run started by
  anything, anywhere.

  `check --auto` now streams its dispatch instead of batching it to the end.
  Deterministic clusters go out before judging even starts, since rules cannot be
  contradicted by a judge, and each judged cluster goes out as soon as the routes
  it touches are done. Verification moved to a per-batch pass to make that
  possible. A cluster that grows after it was dispatched is re-emitted as an
  amendment rather than silently left stale, and `verify-fix` re-judges the whole
  cluster scope, so a partial fix comes back still-open with a fresh brief.

  **Seeing what lookout saw.** `capture`, `check` and `verify-fix` composite every
  shot into one labelled contact sheet, with a view's dark and light captures side
  by side and defect-carrying tiles marked. One image answers "what does this
  actually look like" for the cost of a single read, and full-resolution paths are
  listed beside it, absolute, for close reading. Each fix brief carries its own
  cluster sheet.

  **Agent-agnostic by construction.** `lookout protocol` prints the operating
  contract: what lookout is, the loop, the dispatch protocol, the exit codes and
  the rules. It lives in the tool so any agent can read it, not in a Claude skill
  that other harnesses cannot see and that would drift from the code. Brief
  wording no longer assumes one harness's tool names.

  **Project rules are named, not assumed.** lookout hands work to an agent whose
  configuration it cannot see, so every brief now discovers and lists the rule
  files governing the target repository (CLAUDE.md, AGENTS.md, GEMINI.md,
  CONVENTIONS.md, .cursorrules and the like, in the repo, its subtree and its
  ancestors) and requires them to be read before any edit, with the project rule
  winning wherever it conflicts with the brief.

## 0.3.0

### Minor Changes

- 617d5c4: Add auto mode: `lookout check --auto`, `lookout verify-fix`, and `lookout
backlog plan`.

  New user-visible capability. lookout is executed by agents rather than read by
  people, so auto mode turns a backlog into work an orchestrating session can
  dispatch, and then rules on the result. lookout still edits nothing and spawns
  nothing.

  - `check --auto` clusters open findings by root cause (one target + category +
    attribute; co-located accessibility violations group by route, because an axe
    rule id names the rule that fired rather than the thing that is wrong), writes
    one self-contained brief per cluster under `.lookout/evidence/fix/`, and emits
    a `PLAN.json` carrying the dispatch protocol. Each brief is a complete prompt:
    the defect, the screenshots to read, the repository to change, the rules, and
    the JSON the fix session must reply with. The orchestrating session therefore
    holds cluster ids and verdicts rather than findings.
  - `verify-fix --cluster <id>` re-captures and re-judges only that cluster's
    routes and rules on the claim: exit 0 passed (backlog adjudicated to fixed
    with the commit), 1 not fixed (a fresh brief is written carrying what the
    judge still sees, for a new session), 2 execution error, 3 blocked after
    exhausting `--max-attempts` (default 2, recorded with a mandatory reason). A
    fix session never grades its own work.
  - `backlog plan` re-emits the same dispatch plan from the backlog alone, so
    resuming a fix loop costs nothing.
  - `--severity` sets the dispatch floor, critical and high by default.

### Patch Changes

- 5b39339: Key the judge cache by view group instead of by single shot.

  The rubric asks the judge to compare a view's dark/light pair and its
  form-factor progression, but the cache was keyed on one shot's pixel hash. On a
  scoped re-check after a fix, the changed shot re-judged while its unchanged
  partner was served from cache and never entered the batch, so the judge was
  asked for a comparison with one side missing and quietly stopped filing it. A
  colour-scheme or responsive finding therefore read as fixed when nothing had
  been fixed.

  A view group is now one target + platform + route + state across every form
  factor and scheme; its cache key covers every member's pixel hash, so any member
  changing re-judges the group whole. Batching treats a view group as atomic: an
  oversized group ships alone rather than being split across batches. Existing
  ledger entries miss once and re-warm.

## 0.2.0

### Minor Changes

- 71b3fd8: Capture authenticated routes, compare against design hand-offs, and never
  mislabel a shot that wandered off the target.

  Three new capabilities, all project-agnostic; lookout still knows nothing about
  how any given app authenticates or which design tool drew its hand-off.

  `TargetDef.signIn?: (page) => Promise<void>` runs once per target before its
  routes are captured. The run shares one browser context, so whatever session
  the hook establishes persists across every route, form factor and scheme. A
  project supplies its own flow (clicking a demo-account button, walking an OAuth
  redirect, seeding a token); if the hook throws, the target's routes are skipped
  and recorded as a `signIn` failure rather than photographed signed-out under a
  signed-in label.

  `RouteDef.design?: string` points a route at a design hand-off image, resolved
  relative to the config file. The judge reads it alongside every shot of that
  route and compares one to one. The hand-off is a reference, not an authority:
  the rubric has lookout rule on each divergence by user impact, so it can find
  the build improved on the hand-off (contrast, touch targets, truncation) and
  decline to file it, find the hand-off right and the build drifted, or find both
  wrong and say what correct would be. A new `design-parity` category covers a
  divergence that is only a divergence. Rubric version is now 2, so cached
  judgements re-run.

  A new `off-origin` deterministic check compares each shot's final URL against
  its target's origin. An app that bounces to a login host or an SSO provider was
  previously captured and filed under the route that had been requested, so every
  finding on that shot silently described a different application. That is now a
  critical finding on the shot, ranked alongside `blank-shot` because both mean
  the pixels are not what the shot claims to be. Same-origin redirects stay
  silent.

## 0.1.1

### Patch Changes

- d6e7c70: Publish the package publicly. Scoped npm packages default to restricted
  access; `publishConfig.access: "public"` in package.json is the mechanism npm
  always honors, independent of the changesets-level `access` setting.
