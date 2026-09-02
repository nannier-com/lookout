# @nannier-com/lookout

## 0.40.16

### Patch Changes

- d097cf9: **`Issue.json` is the document's twin.** It was a projection narrower than
  the markdown: no placement, no expected or observed text, no confidence,
  region or seen routes, no attempts, no rendering element, no source location,
  and evidence paths relative to a workspace nobody reading the file is in. It
  now carries every member finding whole (with each evidence path made absolute
  and stamped with when it was captured), every attempt as `state.json` keeps
  it and the baseline the next ruling is measured against, the placement, the
  scope a ruling will photograph, the other issues on the same screenshots, and
  every artifact path with whether it exists. Both files are built from one
  loaded context, so a fact reaches both or neither.

## 0.40.15

### Patch Changes

- ef4fb92: **An accessibility finding names the elements, the standard and each check.**
  axe reports far more than a rule id, and lookout kept the selectors of three
  elements and a flattened summary. The capture now keeps, for up to twenty
  failing elements, a summary of the element's markup (its tag, a few naming
  attributes such as `id`, `aria-label` and `alt`, an `href` stripped of its
  query, and the visible text, at most eighty characters; values, sources,
  styles, handlers and other data attributes are dropped before anything is
  written, because the record is committed with the project), the impact axe
  gave the element, and the sentence each of axe's checks wrote about it, plus
  the rule's tags.

  The ticket's prose spends them: "It fired on 2 elements on this screen: the
  `<h4>` reading "Overview", the `<h5 id="recent">` reading "Recent activity""
  instead of a selector list (the selectors stay in the record for the agent
  that resolves them), "It is a WCAG 2.0 level A requirement" or "an axe
  best-practice rule rather than a WCAG requirement" from the tags, and one
  sentence per check per element in place of the flattened summary. A capture
  from before these were kept reads as before. The issue document also merges
  what the finding kept of its view with what the workspace still records of
  the shot, field by field, instead of letting one shadow the other whole.

## 0.40.14

### Patch Changes

- 2d3cc8a: **Capture records how each view was photographed, and the checks keep what a
  fixer needs.** Every web shot now carries the URL it loaded (with the scheme
  in it) and where it landed when that differs, the viewport in CSS pixels and
  the device scale, how the colour scheme was applied, the element when one was
  framed, and for a state other than rest the planner's description of it and
  the control that was clicked to reach it, with what was expected. The issue
  document prints these ahead of anything it would reconstruct from the config,
  and the finding keeps a copy, so a cleaned workspace loses none of it.

  A thrown page error keeps its stack (twelve frames), which names the file
  and line that threw; a console error keeps its column and how many times it
  fired, counted on the first sighting instead of filed again; a failed request
  keeps its method and resource type; the horizontal-overflow checks keep the
  five worst protruders with their paths, not only the worst; a dead control
  keeps its selector and role and the path it was expected to lead to, and the
  provenance join now names its element too.

## 0.40.13

### Patch Changes

- b00370a: **A finding keeps what the check recorded, how the view was photographed,
  and what the verifier said.** A deterministic finding survived ingestion as
  an attribute, a region and one rendering element; the rest of the check's
  record (every element a rule fired on, the error's location, the offending
  path, the reference link) was written into prose once and then gone, and the
  adversarial verifier's own account of why a judged finding stood was dropped
  outright. Each finding now carries `check` (the check's type and its record,
  bounded: strings to 400 characters, lists to 20 items, nesting to two levels,
  the provenance join left out since `renderedBy` and the sidecar carry it),
  `view` (whatever capture recorded about how the view was photographed:
  today the design hand-off, its hash and the sidecar path; more as capture
  records it) and, on the AI channel, `verifierNote`. All three are refreshed
  when a newer sighting carries them and never cleared by one that does not.
  The issue document lists the check's record key by key under each
  deterministic defect ("What the check recorded") and prints the verifier's
  account under each judged one. `backlog check` rejects an unknown check type.

## 0.40.12

### Patch Changes

- db7f814: `lookout protocol` names every file in an issue's folder (`frames.json` and
  `handoff.command` were missing, and `state.json` now says it holds what was
  reported, what lookout observed and the capture the next ruling is measured
  against), describes where the working evidence lives (`$LOOKOUT_HOME/
evidence/<project>-<hash>/` with the capture and judge reports, the run log,
  the contact sheets, and the `<shot>.png.provenance.json` sidecar beside every
  screenshot with its `shotHash` drift check), and says what `--note` becomes,
  what a ruling is measured against, that a ruling which does not pass spends an
  attempt, and what reopens a blocked issue. Exit 2 is "could not run or could
  not rule; no attempt is spent". The README and the skill no longer place the
  frozen frames under `evidence/fix-frames/`, where they have not lived since
  they moved into the issue's own folder, and the README's fix loop no longer
  presents a scoped `check` before `verify-fix` as a step that affects the
  ruling.

## 0.40.11

### Patch Changes

- aca7bc7: `verify-fix` refuses `--no-capture` (a ruling on the last capture instead of
  a fresh one) and `--axe off` (every accessibility criterion met without the
  check running), before anything runs, with the reason in the error. Both
  passed through to the re-capture and could confirm a fix nothing had looked
  at. A `--settle` that differs from the one the filing capture used is noted
  in the run log rather than refused, since a slow render sometimes needs it:
  pixels may move for reasons unrelated to the fix.

## 0.40.10

### Patch Changes

- 36fea92: **A ruling is measured against the issue's own record, not the workspace.**
  This changes the verdict rule's input. The pixels-moved guard (nothing passes
  on unchanged pixels) compared fresh screenshots to whatever the capture
  workspace held, and the workspace moves with every capture: a `lookout check`
  of the routes between the edit and the ruling put the fixed page in it, the
  ruling compared the fixed page to itself, and a real fix was ruled "nothing
  changed" and spent an attempt. The README recommended that very loop.

  Each shot is now compared, in this order, to the capture of the previous
  ruling (recorded in `state.json` as the ruling's baseline, by shot and hash),
  then to the frame frozen when the issue was filed (frames now record the shot
  they copy and the hash of its pixels; frames frozen earlier recover both from
  the file and the view), and only for shots the issue has no record of, such
  as the routes a shell verify tops up with, to the workspace and the backlog's
  evidence as before. A `check` or `capture` between the edit and the ruling no
  longer moves the baseline. The attempt record, the stdout account and the
  document each say which of the three the ruling compared against.

## 0.40.9

### Patch Changes

- 7bde430: **What `verify-fix` prints after a ruling carries the same facts the
  regenerated document does.** The account now says how many attempts are left
  before the issue blocks, what was photographed (URL, routes, form factors,
  schemes) and what it was compared against (the previous capture's run and
  when it finished, and how many comparable screenshots changed), which routes
  had pixels that never moved, every finding still filed with the judge's own
  account of it, each criterion with its verdict mark, its note, the shots that
  decided it and the verifier's suggestion, what was recorded about the
  repository (the commit, the uncommitted files, the files changed since the
  previous attempt) beside the note verbatim, and that the document now carries
  this attempt, with its path. A blocked ruling names the command that reopens
  the issue. A ruling that could not be made says no attempt was spent. The
  `--json` payload carries the same facts as objects: `attemptsLeft`,
  `stillOpen` with shot ids and the judge's account, `baseline`, `photographed`,
  `reported`, `observed`, `doc`, and `evidence` and `suggestion` on each
  criterion.

## 0.40.8

### Patch Changes

- b0d786a: **The attempt record says what the ruling saw.** `state.json` kept one
  sentence about each attempt; everything else the ruling knew (how many
  screenshots were compared and how many moved, which findings were still
  filed and what the judge said about each, which criteria failed and why, the
  contact sheet, the flags that narrowed the capture) was printed to stdout and
  lost. Each attempt now records all of it, plus what lookout observed in the
  repository at ruling time (HEAD, the uncommitted files with `.lookout/`
  excluded, and the files changed since the previous attempt's commit), kept
  apart from what the fixer reported so a claim is never filed as lookout's own
  fact. The issue document prints every one of these under the attempt, in the
  order a second attempt needs: what was reported, what lookout observed, what
  it saw, then the verdict.

  The acceptance verifier's `evidence` (which shots decided a criterion) and
  `suggestion` (what it would change) used to be dropped when its answers were
  matched back onto the criteria; they are kept now, written onto the criterion
  beside its note, and printed under it in the document.

## 0.40.7

### Patch Changes

- 51ae620: **The issue document says how to see the defect and where everything lookout
  wrote about it lives.** A "How to see it" block per photographed view gives
  the URL with the colour scheme already in it, the viewport in CSS pixels and
  the scale the PNG was taken at, how the scheme was applied (browser
  emulation, a url parameter, or the config's recipe), the element when only
  one was framed, what a state other than rest is and what lookout clicked to
  reach it (from the navigation plan, or the config's recipe description), the
  design hand-off the view was judged against with its hash, the provenance
  sidecar beside the screenshot with how many elements it names and whether
  the shot has been re-captured since, the workspace screenshot, and when and
  by which run it was captured. Facts reconstructed from the config are marked
  "(per the current config)"; facts the capture recorded win over them.

  "Where it renders" now draws on the sidecars for every member, so a judged
  finding, which carries no element of its own, gets the same list of named
  elements with component chains and source hints that a check's finding did.
  An "Artifacts" section names the config, the backlog, the judge ledger, the
  navigation plan, the capture and judge reports, the run log and the contact
  sheets, absolute, each only when it is on disk.

## 0.40.6

### Patch Changes

- 00b8e0e: **The issue document names the other issues filed on the same screenshot.** A
  thrown error, a failed request or a blank capture on the same picture is often
  the cause of the visual defect filed beside it, and clustering gives each its
  own number, so the two documents never mentioned each other. An "Also on this
  screenshot" section lists every open or blocked finding in another issue that
  shares a screenshot with this one, by issue id, severity, rule and title, and
  says that none of them is closed by fixing this one. The materializer hands
  the backlog it already holds to the renderer for this; a caller rendering one
  issue in isolation gets no section rather than a wrong one.

## 0.40.5

### Patch Changes

- fd34280: **The issue document says what lookout will photograph before anyone asks
  for a ruling.** A "Scope of verification" section names the target and its
  URL, every route `verify-fix` will re-capture and which of them the shell
  rule added from the config (a shell defect is ruled on at least two routes),
  the form factors and schemes, the panel that re-judges, and the fact that
  lookout rules on what the URL serves at that moment and never starts, rebuilds
  or restarts anything (with the config's `startHint` when it has one). It
  states the pixels-moved rule and what the comparison is against, naming the
  run that filed the issue and when it finished, and that a `lookout capture` or
  `check` of those routes between the edit and the ruling replaces that baseline
  so a real fix reads as no change. When the capture workspace still holds the
  filing run, the flags it ran with are listed. Every `verify-fix` flag is named
  with what it does to the ruling: which are set from the issue, which narrow
  the capture and the comparison, and which cannot confirm a fix.

  The verify block says `--commit` may be left out, what `--note` becomes and
  what the useful ones have said, that a ruling which does not pass spends an
  attempt (N of M spent), what blocks the issue, that `--max-attempts` raises the
  cap for one ruling, and what every exit code means, including 2: lookout could
  not rule and no attempt was spent. The routes a target's config lists are
  derived once (`configuredRoutesOf`, beside `clusterScope`) for the verb and the
  document alike, so the two cannot disagree.

## 0.40.4

### Patch Changes

- 6f8fbe6: **The issue document says what has been tried.** Every attempt `verify-fix`
  has ruled on was already on disk in `state.json`, and the document printed one
  integer about it. It now carries a "What has been tried" section: each attempt
  as it was reported (commit and the fixer's note, verbatim), what it surfaced
  elsewhere, and what lookout ruled with the judge's account, in the same
  sentences the board's record feed uses (one formatter, `src/fix/attempts.ts`,
  serves both). A judge that saw the same thing twice is written as "unchanged
  from attempt 1" rather than repeated. A blocked issue's document states the
  reason, the command that reopens it, what number the next ruling counts as,
  and what `--max-attempts` would leave one more round.

  **The document regenerated by a ruling now carries that ruling.** `verify-fix`
  saved the backlog (which rewrites the document) and then wrote the attempt, so
  the document could never include the attempt just ruled. The attempt is
  written first now, in both channels.

  **Acceptance criteria say what the last ruling saw.** A criterion checked and
  failed drew the same empty box as one never checked, and its note (the
  verifier's reasoning) printed only when it was not verifiable. Four marks now:
  `[x]` met, `[!]` not met, `[-]` could not be verified, `[ ]` not ruled yet,
  with a legend, the note under every ruled verdict, and when and by which run
  it was ruled.

  **The header states the record.** `status:` (with the adjudication or blocked
  `reason:` when there is one), `confidence:`, `region:` when a member has one,
  `seen on:` when the defect has been photographed on more routes than it is
  filed under, `attempts: N of M spent` naming the default cap, and `caused by:`
  for a regression, with the commit and its forge link. The blocked answer from
  `verify-fix` names the reopen command and the document that records every
  attempt. The default attempts cap lives beside the verdict rule
  (`src/fix/rule.ts`) so the document can state it without importing a command.

- 7ea635a: The live feed's cursor on a card being re-judged is a block again. The
  stylesheet spelled it `"█"`, which is not a CSS escape (CSS wants
  `"\2588"`), so the backslash escaped the `u` and the page drew the letters
  `u2588` after the last line. The ui gate had never captured a card mid-verify,
  so nothing saw it until the fixture gained one.

## 0.40.3

### Patch Changes

- e3e3370: The issue document's sections each live in their own module beside the
  assembly (`src/issues/doc-defects.ts`, `doc-evidence.ts`, `doc-verify.ts`),
  reading from one `IssueContext` that the JSON record (`src/issues/record.ts`)
  shares. The attempt record and the judge's one-sentence account are written by
  one module for both channels (`src/verify/attempt.ts`), the axe scan has its
  own (`src/capture/axe.ts`), and the device scale factor lives beside the
  viewport table so a document can state a screenshot's geometry without loading
  the browser. No output changes: every Issue.md and Issue.json regenerated from
  the ui-check fixture is byte-identical before and after.

## 0.40.2

### Patch Changes

- 73e7196: **The calls-to-action consent moves under the cog.** It was an icon button
  beside play, which made a consequential decision look like a view preference:
  a small outline that changed colour, with the whole of what it authorizes
  living in a tooltip nobody hovers. It is a settings row now, next to where the
  project and the base URL are chosen, and it says in words which of the two
  runs play will spend: `Off: runs photograph each route at rest`, or
  `On for this project`, with the consequence spelled out underneath rather than
  hidden in a title attribute. The row is not a `<label>`, unlike the rows above
  it, so a stray click on the description cannot grant the consent; only the
  button does.

  What it authorizes has not changed, and neither has where it is stored: the
  server still remembers the directory the consent was given for, so pointing
  the page at another project starts from no again.

  The one thing the old placement did well was warn on the way to the button, so
  play keeps that: while calls to action are on, its tooltip says the run will
  click this project's own buttons and links, destructive ones included.

## 0.40.1

### Patch Changes

- 40683a7: **A card's "seen" chip is an age, so it stops behaving like a stopwatch.** It
  rendered the same formatter the header's run clock does, which keeps seconds
  below the hour mark, so an issue photographed forty minutes ago read
  `seen 40m17s` and advanced every second. Every card did it at once, with
  nothing running, and it read as exactly what it looked like: a clock counting
  up against whoever had not fixed the issue yet.

  It was never timing anybody. The number is the age of the evidence, the
  modification time of the newest screenshot the finding was filed against, and
  it climbs until a run photographs that view again. So it is now said the way a
  person says it: `seen 41m ago`, `seen 9h ago`, `seen just now` for the first
  minute, moving once a minute rather than once a second. The word `ago` is part
  of the fix, because `seen 41m17s` can be read as "seen for 41 minutes" and
  `seen 41m ago` cannot. Hovering the chip names the capture it is counting from.

  The run clock in the header is untouched and keeps its seconds, because that
  one is a live measurement: watching it advance is how a reader tells a working
  run from a hung one. `ticks` also writes a clock only when it says something
  different, so the board stops replacing sixty text nodes a second to paint the
  characters that were already there.

## 0.40.0

### Minor Changes

- ee23bb3: **Play stops the run it started, and the judge underneath it.** New capability
  on the page: while a check is in flight, the play button is a stop button, and
  pressing it ends the run and everything the run started, the Claude CLI
  included.

  There was no stop before, and no way to build one from what the server had. A
  run was spawned into this server's own process group, so the only thing that
  could be signalled was the check process itself, and a check is not one
  process: it spawns `claude -p` per batch, and that grandchild is where the
  minutes and the model spend actually go. Measured on 2026-09-01, a parent
  killed with SIGTERM left its child running to completion. Anyone wanting a run
  to stop had to find the process tree themselves.

  A run is now spawned into a process group of its own, and `POST /api/stop`
  signals the group: the check, the judge it is waiting on, and anything either
  of them started. SIGTERM first, and that is not politeness, since playwright's
  own handler is what closes the chromium the run is driving, with SIGKILL four
  seconds later for a group that is stuck rather than closing. The one cost of
  the new process group is that Ctrl-C on `lookout ui` no longer reaches the
  run, so the verb now stops the run itself on the way out rather than orphaning
  it.

  A killed process cannot write its own `run-end`, so the log used to go on
  claiming the run was live and the page animated a clock for it until ten
  minutes of silence made it "stalled". Stopping now writes that line for it, and
  the fold reports the phase as `stopped` rather than `done`, because the run did
  not finish, it was ended.

  On the page the triangle becomes a square inside the ring that was already
  turning, so the control shows what it is as well as what it is waiting on, and
  it dims between the press and the last browser closing rather than pretending
  the click did nothing.

## 0.39.1

### Patch Changes

- 47e8ee8: **A ticket is written for the person reading it as well as the agent fixing
  it.** An accessibility issue used to open with its "what is wrong" section
  saying `heading-order: Heading levels should only increase by one`, then the
  severity and rule, then the same sentence a second time, and nothing else.
  There was no way to troubleshoot from that: it names a rule and explains
  nothing, and a reader who does not already know the rule has been handed a
  label instead of a defect.

  Three separate things produced that, and all three are fixed.

  Deterministic findings had no explanation to give. Ingestion copied the
  check's own message into both the title and the problem, so the two fields
  were one string and the document printed it twice. The checks now explain
  themselves: `src/backlog/explain.ts` writes what a person would notice first,
  then the check's own measurement, for every deterministic type. Accessibility
  violations get the most of it, because they are the ones whose screenshot
  usually looks fine: axe's fuller description, its own severity word said in
  full, which elements on the screen it fired on, its account of what to change,
  and a link to the rule. Two of those, the description and the per-element
  failure summary, were being thrown away at capture time and are now kept.
  `expected` and `observed`, which were empty strings for every deterministic
  finding, are filled. Existing open findings pick all of this up the next time
  their view is captured.

  The judge was asked for one prose field aimed squarely at whoever was about to
  edit code. The reply contract now says `problem` carries two parts in one
  field: a plain sentence a reader who has never seen the screen can follow, then
  the precise statement with the measurements and the rubric vocabulary in it,
  with a worked example of both.

  Every skill lookout has now carries the same rule, from one shared file rather
  than fifteen copies of a paragraph. `{{include:}}` resolves against a skill's
  own directory first and a new shared directory second, `skills/_shared/`, so a
  rule governing every reply is written once. The six judge panels are category
  vocabularies composed into `judge-core` rather than prompts of their own, so
  they carry a one-line pointer and inherit the rule through the core; a test
  asserts every skill has it and every composed panel prompt delivers it, so a
  capability added later cannot quietly leave it out. `improve-skills` gains it
  as a standing criterion, so an amendment written from a project's own signals
  cannot trade the explanation away for terseness.

  The ticket and the board render it as written: the two halves as two
  paragraphs, a problem that is only its own title again dropped rather than
  printed under the heading it repeats, and the element's path through the page
  printed under the component name, which is often a provider that says nothing
  about which element on screen was at fault.

## 0.39.0

### Minor Changes

- 84abba3: **The play button can click the application's calls to action.** Two new
  user-visible things: a toggle beside the button on `lookout ui`, and a
  `--navigation` flag on `check`.

  Navigation discovery, which clicks a route's buttons and links and photographs
  the overlays, drawers and destinations behind them, was reachable only by a
  project writing `navigation: { enabled: true }` into its config, which is that
  project committing to it for every run it will ever have. The toggle is the
  other kind of consent: one run at a time, from the person about to press play,
  visible before they press it. It carries the accent when it is on, because a
  run that clicks the application's own controls is not the same run, and
  everything planned gets actuated, destructive controls included. Consent is
  stored against the project directory it was given for, so pointing the page at
  a second repository starts from no again.

  **Fixed with it: a `--first` walk plans the route it is standing on.** The
  refresh step was gated to full-scope runs, on the reasoning that a scoped run
  cannot see the config's whole intent. `--first` walks the application one route
  at a time by synthesizing `--targets`/`--routes` for every stop, so every stop
  looked like a caller-narrowed run and no plan was ever drawn up: the play
  button, which runs `check --first`, could not have clicked a call to action
  even with the config switched on. The walk sees the whole intent one route at a
  time and now earns the same entry a full-scope check does. A scoped run that
  gets in plans only the routes in its scope, rather than re-planning and
  re-capturing the whole application from inside one stop of a walk. `verify-fix`
  is scoped and never sets `--first`, so a fix ruling still spends nothing there
  and rules on the plan that already exists.

## 0.38.3

### Patch Changes

- d44d74e: Three fixes to `lookout ui`, found by auditing the live socket rather than by
  anything going wrong.

  **A killed run is noticed again.** The page decides a run is abandoned by
  comparing the last event's timestamp against the clock, and that comparison used
  to be re-run by the poll 40 times a minute. Nothing re-ran it once the socket
  replaced the poll, and the case it exists for is exactly the one where no frame
  will ever arrive: a check killed outright writes no `run-end`, so the page went
  on animating a dead run indefinitely. It is now re-read on the page's own
  one-second tick.

  **The live socket refuses a handshake from anybody else's page.** A websocket
  handshake ignores the same-origin policy and needs no preflight, and this server
  greets a new socket with the board and the judge's transcript before the other
  end says anything, so any page in any tab could read the project's absolute
  path, every issue on it, and the narration. The handshake is now refused unless
  the `Origin` matches the address it was made to. The HTTP routes never had this
  exposure and are unchanged.

  **A re-captured screenshot is no longer served from the browser's cache.** The
  thumbnail ETag was base64 of its key truncated to 32 characters, which is the
  first 24 bytes of an absolute path: every thumbnail shared one ETag and the
  mtime, size, width and fit it exists to distinguish were cut off the end. A
  re-capture revalidated as unchanged, so the board kept showing the defect that
  had just been fixed. It is hashed now.

## 0.38.2

### Patch Changes

- 06fcf3d: The transcript rail goes quiet when the judges do, and empties when you point
  lookout somewhere else.

  Three defects in the rail, all found by re-reading it rather than by using it,
  which is why none of them had shown up:

  The rail decided "a judge is speaking" from the last line of whatever frame had
  arrived. That line is as likely to be the `close` saying one just stopped, so
  the pulsing dot and the judge's name stayed on for as long as the tab was open,
  long after the run had finished. It now tracks which calls are open, and says
  nothing when none are.

  A call that threw never wrote its `close` at all, because `closeCall` sat after
  the model call rather than in a `finally`. A failed panel is exactly the one
  whose end matters, and it was the one that never ended.

  Pointing lookout at another project left the previous project's judges on the
  rail. The server decides a page must clear from the file having got shorter,
  which catches a new run and a trim but cannot catch a different file: the new
  one being longer or shorter says nothing. A switch is now recorded when it
  happens, so the next frame carries the clear, including the case where the new
  project has never been captured and there is nothing to send but the clear
  itself.

## 0.38.1

### Patch Changes

- fe35ba7: The shot inspector carries a close button in the corner of the picture itself.

  The bar's "Close" sits at the corner of the screen, which is not where anyone is
  looking once a screenshot has their attention. A round cross now sits over the
  top right of the picture, with its own dark scrim and light ring so it reads
  against whatever the screenshot happens to show there. It closes the inspector
  like the bar's button, the scrim and the Escape key do, and the interaction gate
  drives all four.

## 0.38.0

### Minor Changes

- eb3b2df: The judge's column folds away.

  New capability: a control in the transcript's header that folds it down to a
  strip the width of the rail on the other side of the page, and unfolds it
  again. The choice is remembered per browser, so the page comes back the shape
  it was left in.

  The transcript is a fixed column rather than a drawer on purpose: the question
  it answers ("is this thing still working?") is one you have while looking at
  something else, and a drawer you have to go and open answers it too late. What
  that costs is 340px of board, held whether or not anything is being judged, and
  on a laptop that is a column of cards. Folding hands the width back without
  giving up the answer: the strip keeps the live dot, so a judge that starts
  talking still says so.

  Shut, the page has the same furniture at both edges: icons on the left, a way
  back into the transcript on the right. `tools/ui-check` captures the folded
  state as its own view and drives the control through folding, reloading and
  unfolding, so both shapes are gated the way every other region is.

### Patch Changes

- 07541e0: `lookout ui` no longer times out the folder picker, and drops a heartbeat that
  was doing nothing.

  bun has two `idleTimeout` options: the one on the `websocket` handler governs a
  socket, and the one at the top level is the HTTP inactivity timeout. The value
  was set at the top level believing it governed the socket. It did not. What it
  did govern was every HTTP request, and that turns out to matter: `POST
/api/pick` opens a native folder picker and does not answer until somebody has
  chosen a directory, while bun's default closes a quiet connection after ten
  seconds. The option now carries the maximum bun accepts, named for the reason
  that is real, so choosing a project from the page cannot fail for anyone who
  browses rather than types.

  The server's own thirty-second ping is removed. bun's `sendPings` defaults to
  true, so it already pings and answers pings; a socket with no ping of lookout's
  stays open indefinitely.

## 0.37.5

### Patch Changes

- c02bbda: Two judges talking at once no longer shred each other's verdicts.

  A check runs two workers over view groups and both walk their panels in the
  same order, so at almost every moment two calls to the SAME judge are in flight
  against different views. The transcript gathered prose by judge NAME, so those
  two streams went into one buffer: reassembled, a single `judge-integrity`
  heading carried two JSON replies spliced together, with nothing to say which
  view either half belonged to. Measured on a two-route run, every one of the ten
  panel calls came out spliced.

  Narration is now gathered per call rather than per name, and every line carries
  the id of the call that wrote it. The rail grows each call's paragraph in its
  own block instead of appending to whichever block came last, and a call's
  heading names the view it is judging (`judge-integrity app/dashboard · 6
shot(s)`) so two blocks under the same judge can be told apart. The same
  two-route run now produces ten calls, each with its verdict intact.

  `tools/ui-check`'s fixture seeds two interleaved calls of one judge, so the
  visual gate covers the case rather than only the tidy one.

## 0.37.4

### Patch Changes

- 1d453ec: The shot inspector can be dismissed by clicking beside the picture, and its
  close control says "Close".

  Opening a screenshot from the board left people stuck in the overlay: the only
  ways out were the Escape key and a bare multiplication sign in the corner of a
  bar that, in the dark scheme, is nearly the same colour as the scrim behind it.
  Clicking the darkened area around the picture, which is what anyone tries first,
  did nothing at all.

  Three changes, all in the overlay:

  - A click that lands on the scrim rather than on the picture, a box or a control
    closes the inspector.
  - The close button is labelled, filled and carries its shortcut in a tooltip,
    instead of being a lone glyph on a near-black bar.
  - The element-provenance layer no longer swallows clicks that fall between its
    boxes, so a click on the picture reaches the picture.

  The interaction gate had covered Escape only, which is how an overlay nobody
  could click their way out of shipped; it now drives all three exits and asserts
  that clicking the picture itself does not close it.

## 0.37.3

### Patch Changes

- d5133ad: `mergeLatest` rejects a capture report with no runs instead of crashing on it.

  Every finding a merge files is stamped with the latest capture run, read off
  `report.runs[report.runs.length - 1]`. The existing guard only asked whether
  `capture-report.json` was there at all, so a report whose `runs` array was empty
  got past it, the read came back undefined, and the merge died on
  `TypeError: undefined is not an object (evaluating 'latestRun.id')`. It surfaced
  through `lookout check --no-capture` against a hand-authored report.

  `lookout capture` always records a run, so nothing in the normal pipeline can
  produce one of these: the reports that look like this are truncated or written
  by hand. That still makes them malformed input, and malformed input gets a
  LookoutError naming the problem, as it does everywhere else in this file. The
  crash also mattered beyond the message: `lookout self-heal` reads the incident
  log, and an unhandled TypeError was recorded there as a lookout crash rather
  than as the operator error it is.

  The other three readers of `report.runs` were checked and left alone.
  `backlog/check.ts` already tests the length. `verbs/verify.ts` and `verbs/ask.ts`
  read the report immediately after `runCapture`, which appends a run through
  `mergeRun` on every path and throws when nothing was captured, so their
  assertion is an internal guarantee rather than a boundary read.
  `verify/evidence.ts` optional-chains, and now goes through this guard first
  anyway, since it merges before it re-reads the report.

## 0.37.2

### Patch Changes

- 481b603: The frozen-regression gate no longer rolls back an amendment for the judge's own
  run-to-run spread.

  Measured on a 63-claim frozen set, replaying with the skills completely
  unchanged lost 6 claims on one run and 22 on the next, all of them "lost". Since
  `skills improve` rolls a candidate back on any violation at all, a baseline that
  reliably violates closed the gate permanently, and reported it as "the amendment
  broke settled verdicts".

  Two causes, both addressed without weakening the check:

  - A mustFile claim is now satisfied when its PANEL filed something on that shot,
    not when that exact category came back. A panel owns several categories and
    moves a defect between them freely: composition kept 15 of 15 while
    consistency kept 0 of 6, both judge-craft, and every lost consistency claim sat
    on a shot where a composition claim was retained. The panel is already the
    gate's unit of causation, since only the amended panel replays. When the label
    does move it is reported as drift rather than discarded. mustNotFile keeps its
    exact category: widening that direction would invent violations, not remove
    them.
  - A violation must now be evidence rather than one sample. It is re-judged until
    it has recurred every time, and what survives is judged once more with the
    candidate withdrawn. A claim the unchanged skills lose too is reported as
    stale instead of blamed on the amendment. Both rounds re-judge only the view
    groups in dispute, so a clean replay costs exactly what it did before.

  `skills improve` still demands zero violations; there is no tolerance threshold.
  `skills replay` prints drift alongside violations and says that one replay is one
  sample.

## 0.37.1

### Patch Changes

- 2524f2e: `lookout skills freeze` no longer enshrines claims about screens the project
  stopped serving.

  The frozen set is capped at twenty screenshots, and until now a settled finding
  whose route or state had been deleted from `lookout.config.ts` could still take
  one of those slots. The only thing keeping such a finding out was its PNG
  happening to be absent, which is not a rule: `capture` prunes an out-of-config
  shot from the report and deliberately leaves the pixels behind, because backlog
  findings still point at them. So a project that had dropped four routes froze a
  set where a quarter of the cases, and a fifth of the claims, were about screens
  the app does not render, and those claims then gated every future skill
  amendment forever, with no run left that could ever re-adjudicate them.

  Selection now asks the same question `check` asks of a stored shot: is this
  route, on this target, in this state, still something the config names? The
  predicate that answers it moved to `src/config-scope.ts` so both callers share
  one definition. Freeze also reports what it left out, since "nothing settled
  yet" is the wrong thing to tell somebody whose verdicts are all about routes
  they deleted.

  Nothing is deleted from the evidence workspace: the backlog still references
  those screenshots, and removing them would leave findings pointing at nothing.
  A set frozen before this change keeps its stale claims until `lookout skills
freeze` is run again, which rebuilds the manifest from scratch.

## 0.37.0

### Minor Changes

- 1e9510a: The page shows what the judge is saying, as it says it.

  New capability: a transcript rail down the right of `lookout ui`, streaming the
  model's own output live. Every tool call it makes ("Read
  web/app/dashboard/rest/desktop/dark") and every word of the verdict it writes
  appear as they happen, under the name of the judge saying them.

  Judging is the part of a run that takes the time and it was the part with
  nothing to look at. Pressing play captured six screenshots in nine seconds and
  then went quiet for eight minutes per view group while five judges read them in
  turn, which is indistinguishable from a run that has died. The rail is the
  answer to "is this thing still working", asked while looking at something else,
  which is why it is a column that is always there rather than a panel to go and
  open. It hides below 900px, where a board has no room for a second column.

  The stream arrives on the socket the page already holds open, as its own kind
  of frame: the board is sent whole because it is small and changes rarely, while
  narration is sent as a delta because a judge mid-verdict speaks several times a
  second. A page that arrives in the middle of a run is handed the transcript so
  far rather than only what happens next, and one whose socket never opens falls
  back to `/api/narration`.

## 0.36.13

### Patch Changes

- 7336757: A run says which judge is working, and writes down what it says.

  Judging emitted one line when it started and the next when a whole view group
  was done. A view group is five panel calls of about a minute each, so that was
  five to eight minutes in which a working run said nothing at all, which on a
  page reads exactly like a run that has died. It also called those five calls
  "1 batch", which is true of the report and misleading about the clock. Both
  counts are now quoted, and each panel narrates as it begins: `judge-geometry on
app/dashboard (2/5)`.

  Underneath that, what the judges actually say is written to `narration.jsonl`
  in the capture workspace, beside the event log rather than in it: the event log
  is the durable record a board is rebuilt from and is re-read in full on every
  push, while narration is a tail nothing is reconstructed from and is written a
  hundred times more often. It is capped, discarded per run, and only produced
  when something is listening, so a run judged from a terminal with no page open
  costs nothing extra.

## 0.36.12

### Patch Changes

- f54cab3: A judge call finishes when the model finishes, not ten minutes later.

  Every AI call lookout makes went through `execFile`, whose callback fires when
  the subprocess's stdout reaches end-of-file rather than when the subprocess is
  done. Those are different moments: anything that outlives the CLI while holding
  the pipe it inherited holds that end-of-file open with it. Measured on a real
  run, the first judge call of every judging phase returned its verdict in about
  a minute and then sat there until the ten-minute timeout released it, three
  times out of three, which on a thirteen-route check is close to two hours of
  waiting for nothing. Nothing surfaced, either: the child had exited cleanly with
  its answer buffered, so the reply was correct and no error was ever raised.

  The CLI is now asked for `stream-json` and driven with `spawn`, and the call
  completes on the CLI's own result message. That makes the end of the answer
  something lookout sees rather than something it waits for, whatever else is
  still holding the pipe. Reading the stream is also what lets a caller watch a
  call in progress: `invokeClaude` takes an `onSay` callback that is handed the
  reply as it is written and each tool call as it is made.

## 0.36.11

### Patch Changes

- f27848b: `lookout ui` is pushed to over a socket rather than polled.

  The page asked `/api/status` every 1.5 seconds, which suited neither side of
  what it watches: a `check` says nothing for a minute and then files a finding,
  so the poll was too slow to feel live and too frequent to be idle. The server
  now holds a socket open per page and writes to it when the run log or the
  backlog actually moves, which means a finding reaches the board in about a
  tenth of a second and a board nobody is running anything against costs no
  traffic at all. A run started in any terminal reaches the page, not just one
  the play button spawned, because what is watched is the disk rather than the
  child process.

  Serving moved from node's http server onto bun's, which is what lets one route
  upgrade instead of answer. Every route keeps its URL, its method and its body.

## 0.36.10

### Patch Changes

- 10277a4: The shared judging core is named `judge-core` rather than `visual-judge`.

  It stopped being the thing that runs when the six specialist panels landed: it
  is the skill every panel prompt is composed from, and the old name said
  otherwise. The composed prompt bytes are unchanged, so cached judge verdicts
  survive the rename.

  A skill's name is also the directory a project's own amendments live in, so the
  rename would have orphaned every lesson a project had learned about the core,
  and every unread proposal, in a directory nothing reads again. A project's layer
  is now read from the retired directory when only that exists, and moved to the
  current name the next time an amendment is written. Projects carrying a
  `.lookout/skills/visual-judge/` layer keep it working with no action needed.

## 0.36.9

### Patch Changes

- 3bb3318: Deterministic findings are joined to the elements they fired on, exactly at
  capture time: axe target selectors and a new overflow offender path (both
  overflow branches now name one) are re-queried against the live page and
  matched to the provenance walk, landing as renderedBy on backlog findings
  (refreshed each sighting) and reaching the placement judge's brief as "this
  finding's element". An unresolved selector writes nothing: the join stays
  exact or stays silent.

## 0.36.8

### Patch Changes

- 4fe186c: Issue tickets state which judge filed them: every AI finding carries the
  owning panel's stamp from ingestion through merge (newest sighting wins, so
  a re-partitioned category follows its current owner), the cluster exposes
  it, the ticket header reads "found by: judge-<name>" (pre-panel backlogs
  still say "visual judge"), and self-improvement signals prefer the stamp
  over deriving from the category.

## 0.36.7

### Patch Changes

- fb961cf: verify-fix re-judges an AI cluster with only the judge panel that owns its
  category; the sibling panels' standing findings still serve from their cached
  verdicts, and moved pixels still invalidate every panel at once, so closure
  is always backed by a fresh judgment. backlog check learns which panels the
  last judge run actually asked, so a panel-scoped run never reads as
  drift-resolved for the lanes it deliberately skipped.

## 0.36.6

### Patch Changes

- 87885c1: Adjudicating a whole issue at once: ruling an issue by-design applies the
  same per-finding transition to every member and records a durable ruling on
  the issue itself, so a sibling finding that arrives later (a new route or
  form factor) inherits the ruling instead of reopening the issue forever.

## 0.36.5

### Patch Changes

- 290d070: The shot inspector draws its provenance overlay: element boxes projected onto
  the image as percentages of its intrinsic size (per the sidecar's own mapping
  contract, so any display size and clamped captures stay exact), innermost
  element winning hover, click pinning the hint: component chain, source
  file:line, a concrete DOM handle, and the element's text. Frozen fix-frames
  never advertise a sidecar: they are copies served from outside the evidence
  root; the live tile carries the inspector.

## 0.36.4

### Patch Changes

- a4bf8cc: The local page gains a shot inspector: a plain click on any screenshot tile
  opens a lightbox with the full image, an open-PNG escape hatch, and keyboard
  close that returns focus without disturbing filters; modified clicks keep
  opening the raw PNG. Groundwork for the provenance overlay; without a sidecar
  the inspector says so plainly.

## 0.36.3

### Patch Changes

- 7ced119: Board shots advertise their provenance sidecar when one sits beside the PNG,
  so the page can offer the shot inspector without probing (a probe's 404 is a
  console error the ui gate fails on). Data only; no pixel changes.

## 0.36.2

### Patch Changes

- 91f5e1c: Two readers the evidence move left behind. `backlog merge` read the judge
  report from the project's old `.lookout/evidence`, where `check` no longer
  writes it, so a merge from disk silently dropped every AI finding; it now reads
  the capture workspace under the operator's home, and still adopts a report an
  older lookout left in the project. `lookout ui` printed that same old path in
  its "watching" banner, pointing anyone debugging at a directory nothing uses.

## 0.36.1

### Patch Changes

- df57c44: The design-placement judge starts from observed facts: its prompt now carries
  a "What was rendering there" block built from the defect's provenance
  sidecars (component chains and source files seen on the running page, hash
  drift annotated), with instructions to open every named file before trusting
  it and to fall back to searching when the block is empty. Skill version 2; no
  ledger or replay consequences, since design-placement sits outside every
  panel identity and is deliberately ungated.

## 0.36.0

### Minor Changes

- b6968fb: Web capture now records rendering provenance: beside every shot lands a
  `<shot>.png.provenance.json` sidecar mapping the rendered elements (geometry
  in document CSS px, ids, test ids, classes, text, CSS paths) to the
  components and, where the page's dev tooling exposes it, the source files
  that produced them (React dev fibers, Vue, Svelte, and data-source style
  attributes; production builds honestly degrade to element identity). The
  sidecar carries an exact pixel-mapping envelope (origin, scroll, viewport,
  actual PNG size) that stays correct for element crops and Chromium-clamped
  tall pages. On by default: the walk is passive, read-only, spends no model
  money, and a failure never costs the shot; disable with `provenance: false`,
  a per-route `provenance: false`, or `--no-provenance`. Provenance is not a
  judge input: it enters no cache identity and no fingerprint.

## 0.35.2

### Patch Changes

- ded2424: ui: header notices render in the notice style again. paintWhere() toggled a
  class literally named "page.notice", which no stylesheet rule matches, so every
  notice (a failed run's stderr, a missing config, a pick error) rendered as a
  quiet rtl-ellipsized path in the path colour. The toggled class is now
  "notice", matching .where.notice in shell.css: red, ltr, wrapped in full.

## 0.35.1

### Patch Changes

- 9d21c37: Navigation discovery is documented: the README's config reference and a
  dedicated section with the click-everything warning, the protocol text agents
  read, the agent-facing skill's practical notes, and a verify-acceptance
  amendment telling the verifier that non-rest states may decide criteria that
  used to be not-verifiable.

## 0.35.0

### Minor Changes

- 67bd9eb: The capture workspace moves out of the judged project, and every issue folder becomes self-contained.

  Shots, the capture report, the run log and contact sheets now live in one workspace per project under LOOKOUT_HOME (default `~/.lookout/evidence/<project>-<pathhash>/`), keyed by the project's real path so separate checkouts stay separate. A judged project's `.lookout/` now holds only the durable record: the backlog, the ledger, the skill amendments, and issue folders that carry their own frozen pixels (`img/pre`, `img/post`, `frames.json`). The user-visible capability: an issue dossier is complete in itself, so it can be zipped, diffed or handed to an agent whole, and cleaning the workspace can never cost a project the picture of a defect.

  Frames an older lookout froze under `.lookout/evidence/fix-frames/` are adopted into the issue folder the first time they are read. The rest of an old `.lookout/evidence/` directory is never written again and is safe to delete; the next capture rebuilds its report in the new workspace.

## 0.34.1

### Patch Changes

- 96215e6: The generated config's `startHint` now follows the project's lockfile (bun,
  pnpm, yarn, npm in that order of evidence) instead of assuming `bun run dev`
  for everyone. No lockfile means the npm default.

## 0.34.0

### Minor Changes

- ac2fb06: lookout check now discovers and exercises a route's interactive affordances.
  Capture harvests every route's buttons, links, and CTAs; the new
  plan-navigation skill curates them into a cached interaction plan (re-planned
  only when a route's affordances change, capped per run); and capture executes
  the plan as first-class states, so the judges rule on overlays, tabs,
  post-click pages, and dead CTAs instead of only the initial render. Opt in
  with navigation.enabled in lookout.config.ts; lookout clicks everything by
  default, including destructive controls, ordered last with sign-in recovery,
  so point targets at a disposable environment and use navigation.exclude for
  anything untouchable. New flags: --no-navigation skips discovery for a run,
  --navigate forces a re-plan.

## 0.33.4

### Patch Changes

- b8e7104: The design-kit registry lists only community kits now: the Canvas entry is
  removed, and the comments that used it as the worked example use public kits
  instead. An in-house kit was never the registry's to name; it is found by the
  workspace scan or declared as `designSystem` in `lookout.config.ts`, exactly
  as the registry's own admission policy prescribes.

## 0.33.3

### Patch Changes

- 7373c5a: Groundwork for navigation discovery: the NavigationConfig surface is
  validated, route fields (name, element, states, navigation) are validated
  instead of cast through, and scope/pruning treat states named by
  .lookout/navigation.json as configured intent. Inert until a plan exists.

## 0.33.2

### Patch Changes

- 53cf27b: Freezing stops minting unsatisfiable claims: a verified design-parity finding
  no longer freezes into a mustFile no replay could ever satisfy (frozen cases
  carry no design reference). The README and the repo guide describe the
  six-specialist judge and the panel registry.

## 0.33.1

### Patch Changes

- 286fc70: The regression replay scopes to the amendment: amending one panel replays
  that panel alone, amending the core or the refuter replays every claim-owning
  panel, and skills replay accepts --skill to run the same scope by hand.
  mustFile claims grade only the panels that ran (an unrun panel's prompt is
  byte-identical to the run that settled them), which also retires frozen
  design-parity claims nothing could ever satisfy. A gated panel with no
  claims in its lane routes to a proposal instead of a vacuous auto-apply.

## 0.33.0

### Minor Changes

- 4ece7dd: The visual judge is now six specialist judges, each its own agent per view
  group. This minor adds the user-visible capability: specialized panel judging
  (judge-integrity, judge-geometry, judge-visibility, judge-text, judge-craft,
  and a design-parity judge that runs only when a design reference exists),
  per-panel cached verdicts so amending one specialist re-judges only its own
  rulings, the new --panels flag to narrow a run to named judges, and findings
  that state which judge filed them. The regression replay now grades an
  amendment by running exactly the claim-owning panels. Upgrading re-judges
  every cached verdict once: the rules genuinely changed.

## 0.32.5

### Patch Changes

- dddded5: Self-improvement signals route to the specialist that erred: a refuted
  finding teaches the panel the report stamps (old reports still teach the
  core), a by-design adjudication teaches the owning panel or, when it
  overrules the verifier, the refuter with a license on that panel, and
  blocked issues and undecidable judge-authored criteria teach the panel that
  owns the issue's category.

## 0.32.4

### Patch Changes

- 1598140: The six judge panels register with the self-amendment loop: they list in
  lookout skills, the five always-on panels join the regression gate
  (design-parity stays proposal-only, since the frozen set carries no design
  references), and the pair rule generalizes to the family: a judging signal
  licenses its panel, the core, and the refuter, and never a sibling panel.

## 0.32.3

### Patch Changes

- 34bedb2: The judging work unit becomes (view group x panel): panels of one group run
  sequentially inside a worker with one pooled refuter call per group, a failed
  panel poisons only its own cache entry, replies are held to the panel's lane,
  every AI finding is stamped with the specialist that owns its category, and
  --panels narrows which panels judge while cached verdicts still serve. With
  the single transitional panel shipped today, behavior is unchanged.

## 0.32.2

### Patch Changes

- 190cecf: The judge ledger keys verdicts per panel: the key gains a panel segment
  (groupHash@vN@panel@promptHash@model), entries record which panel ruled, and
  pruning drops the unreachable four-segment keys of the old format. The whole
  composed rubric rides as a single transitional "all" panel until the pipeline
  judges panels separately, so behavior is unchanged beyond the one-time cache
  re-judge the new key format owes.

## 0.32.1

### Patch Changes

- fbf67d5: The category vocabulary moves out of the monolithic rubric into six panel
  skills (judge-integrity, judge-geometry, judge-visibility, judge-text,
  judge-craft, judge-design-parity), composed back through the core rubric's
  new {{panel}} slot. Judging behavior is unchanged: the rubric text is
  regrouped, not rewritten, but the prompt hash moves, so every cached verdict
  re-judges once on upgrade.

## 0.32.0

### Minor Changes

- 16272b7: The config is `lookout.config.ts` at the project root, and lookout writes it.

  New user-visible capability: a project's config now sits at its root, beside
  `package.json`, instead of inside the gitignored `.lookout/` directory, so it is
  committed and shared like any other tool's config. lookout creates it rather
  than only reading it. `lookout init` writes it, and a verb that needs a config
  and finds none writes one too, seeded from `--url` when the run supplied one and
  left as a template to edit when it did not.

  A project still holding `.lookout/config.ts` keeps working and is moved up to
  the root by the first run that finds it, with the `rubric` and route `design`
  paths inside it repointed, since those resolve relative to the config file.
  Anything the move could not place on its own is named rather than guessed at.
  `.lookout/config.{ts,js,json}` still loads, so nothing breaks on upgrade.

## 0.31.14

### Patch Changes

- 6eddfa9: Deterministic accessibility findings join the region model. Axe already
  records the violating nodes' selector paths, and a violation whose reported
  nodes all sit inside the same `nav`, `header` or `footer` landmark (element or
  explicit role; class names never consulted, samples of larger violations never
  trusted) is derived as that shell region. A chrome a11y cluster then keys by
  region instead of route, so one malformed nav landmark stops minting one issue
  per route; when a cluster key re-derives unambiguously, the existing issue id
  succeeds to the new key with its folder, acceptance verdicts and history, the
  old key recorded in `priorKeys`. `backlog check` gains an `issue-orphaned`
  report for records whose key clusters nothing any more; ids are never pruned.
  A load/save round trip on a real project backlog stays byte-identical.

## 0.31.13

### Patch Changes

- 9d3c82e: Behind the new `shellScoping` config flag (default off), a finding the judge
  places in a shell region is fingerprinted by that region instead of its route,
  and the route-scoped records it supersedes fold into it as it is re-found: one
  chrome defect becomes one finding carrying the union of its history. Status
  folds by precedence (by-design over blocked over open over fixed) so an
  adjudication is never lost, the folded record keeps its earliest first-seen,
  its routes in `seenRoutes`, and the old fingerprints in `absorbed` as the
  audit trail; each collapse is narrated to the event log. Records whose region
  was explicitly answered `content` are never absorbed. Off by default for a
  release so regions accumulate inspectably before any identity moves.

## 0.31.12

### Patch Changes

- 5d047bd: By-design signals only reach the skill that made the claim. The signal
  gatherer read every by-design adjudication as a lesson for the judging
  skills, keyed on the `verified` flag; but deterministic findings are born
  `verified: true` because the measurement is its own evidence, so a person
  ruling an axe violation or console error intentional produced a signal
  telling the refuter it had confirmed a finding it never saw, and through the
  pair rule licensed amending both judging skills off evidence about neither.
  Now a by-design on a measurement (deterministic, or a scanner-found
  hand-roll) emits no signal: it is the project's tolerance for a check no
  amendable skill controls. A by-design on a skill-found hand-roll routes to
  kit-conformance, whose claim the person actually overruled. Signal keys
  exclude the skill, so evidence already consumed under the old attribution
  stays consumed.

## 0.31.11

### Patch Changes

- 57f2ea1: The judge names, per finding, which part of the frame the defect lives in:
  content, shell-nav, shell-header, or shell-footer, a closed vocabulary in the
  reply contract (judge-findings-v2, skill v5). An unknown or missing region
  degrades to content with an incident, never a rejected finding. Shell-regioned
  open findings now travel to every batch's ALREADY FILED aid, so different
  routes reuse one name for one chrome defect instead of each minting a fresh
  attribute; until a project has any shell finding, its open findings travel
  instead, capped worst-first. The region is stored on the backlog record
  (adopted on refresh where none was recorded, never overwritten) but does not
  change any fingerprint yet: identity moves in a later release, after regions
  have accumulated to inspect. The rubric also states, promoted from a lesson a
  project layer learned, that problem text and acceptance criteria are written
  from the screenshot in front of the judge alone.

## 0.31.10

### Patch Changes

- b3c09b3: `lookout init` now keeps the whole `.lookout/` directory out of git, not just
  the evidence: the backlog, issue folders and learned skill layers are
  lookout's working state, per-checkout by decision. The README's
  where-things-land section states the consequence plainly (state does not
  follow the repo, deleting the directory re-rolls issue ids) and names
  `config.ts` as the one authored file worth un-ignoring when a team should
  share it.
- 6f7976b: A finding can carry a region: which part of the frame the defect lives in,
  from a closed set (content, shell-nav, shell-header, shell-footer). For a
  shell region the fingerprint's route slot becomes `@<region>`, so one chrome
  defect is one identity across every route it is photographed on; content and
  absent derive byte-identical fingerprints to before, verified by a load/save
  round trip on a real project backlog coming out byte-identical. Inert in this
  release: nothing sets a region yet, so no existing backlog changes shape.

## 0.31.9

### Patch Changes

- 951cae8: Only the judge's own findings freeze into regression claims. Deterministic
  measurements (axe rules, console errors, overflow checks) used to become
  mustFile claims the replay judge is forbidden and often unable to satisfy,
  because the rubric bars restating a deterministic signal and the replay never
  re-takes the measurements; every such claim read as "lost" and rolled back
  every amendment. By-design deterministic findings stay out of mustNotFile for
  the mirror reason: the person ruled on the measurement, not on the judge's
  visual net. Manifests frozen before this fix should be rebuilt with
  `lookout skills freeze`.

## 0.31.8

### Patch Changes

- 3e6f926: The visual judge now owns the whole frame. The rubric gains a section saying
  every component in the screenshot is in scope, persistent chrome included, and
  judging procedure step 6 no longer tells the judge that a defect appearing
  elsewhere in the application is somebody else's batch to file. That clause was
  written to stop one batch filing on behalf of routes it cannot see, but
  persistent chrome appears on every route by definition, so every batch stood
  down and a nav rail defect was nobody's to file. The replacement states the
  positive rule: file chrome defects from the view in front of you; lookout
  merges one defect reported from several views into one piece of work. The
  matching boundary is stated too: a region not visible in the shot is not one
  the judge may rule on.

## 0.31.7

### Patch Changes

- bc3967d: Every card on `lookout ui` links its own `Issue.md`, and the page serves it at
  `/issue/<id>/Issue.md`. The card has always printed the issue folder, which is
  the right thing to hand somebody at a terminal and no use to somebody reading
  the board: a browser refuses a `file://` link written into a page it loaded
  over HTTP, so the document was unreachable from the one surface built for
  reading issues. A card whose folder is not on disk shows no link at all rather
  than one that answers 404, and the route serves that one file name under a
  six-digit id and nothing else. `tools/ui-check` gained the fixture material and
  the drive checks for both states, and its throwaway git checkout now commits at
  a fixed date, so rebuilding the fixture stops reporting two changed learning
  views that were only new commit hashes.

## 0.31.6

### Patch Changes

- 6ae7e96: `check --first` (the walk behind the UI's play button) now re-tests routes
  lookout has already ruled fully fixed, first, on every run. A fix in one area
  can regress another, and the walk used to order fixed routes with the
  never-dirty rest, behind a stop rule that ends the run at the first standing
  issue, so a regression on a fixed route stayed invisible until the whole
  backlog ahead of it cleared. Walking them first costs almost nothing when
  they are unchanged (one capture and a ledger hit, no judge calls), and when
  their pixels moved the judge runs exactly where a regression could be: the
  merge reopens the finding and the walk stops with the newest breakage while
  its cause is still the most recent commit.

## 0.31.5

### Patch Changes

- 015c926: Pin the `lookout verify` verb's contract with tests: the flag guards, file-vs-inline criteria resolution, the verify-report.json shape gatherSignals consumes, the exit-code contract (a failed criterion exits 1; not-verifiable exits 1 only under --strict), and the MAX_VERIFY_SHOTS cap refusing before any model call. The mock claude gains a MOCK_CRITERIA reply override for verdict shapes the default reply cannot express.

## 0.31.4

### Patch Changes

- 20bbc4e: The frozen-set replay now runs the refuter once per view-group batch, exactly
  as `check` does, instead of collecting every batch's findings into one call.
  The gate grades amendments to refute-finding, and a candidate graded in a
  context window and index space production never uses could be rolled back for
  a "lost" defect production would keep. The judge's missing "ALREADY FILED"
  aid is the opposite case and is now documented and pinned as deliberate:
  rebuilding it from the frozen claims would put the gate's own answer key into
  the prompt, letting a blinded judge pass by parroting the list.

## 0.31.3

### Patch Changes

- c0d06be: The README catches up with the trigger redesign: the learning section
  documents the automatic improve trigger and its off switches, the watermark,
  and `--propose`; the self-heal section documents the deterministic group
  pick, heal markers, the reply-contract forfeit, and the discovered replay
  gate; and the "never truncated" claim about the incident log now names the
  one compaction that rewrites it.

## 0.31.2

### Patch Changes

- c8ecabc: The learning loop is visible. The page's gate section always states how
  many NEW signals wait, since when, the threshold, and that the next check
  learns from them (the number can go down now that improve consumes what it
  is shown, which is what earns it a badge spot alongside a windowed count
  of recurring failures). Incident rows say their state in words: recurring
  and worth a manual self-heal, healed-before-and-came-back, or
  two-attempts-reverted-needs-a-person, instead of a CSS class being the
  whole account. `lookout doctor` gains a "lookout itself" section with the
  active groups and the heaviest one, and a check's human output ends with
  one ignorable line when the machine has recurring failures.

## 0.31.1

### Patch Changes

- 5186bf8: self-heal gets a lifecycle. lookout now picks the one group a run works on
  (highest 30-day pressure among active groups; the model no longer chooses
  from a menu of twelve), committed heals are marked in `~/.lookout/
heals.jsonl` so a settled group stops being offered while one that recurs
  comes back loudest, groups with two reverted attempts wait for a person,
  and the log compacts entries older than 90 days once it outgrows 2000
  lines (reads were capped at the last 200 lines while sorting by count, so
  old floods dominated invisibly). An unparseable healer reply now forfeits
  its edits: reverted, kept for a person with the raw reply, recorded as an
  incident, exit 1; it previously became a commit whose subject was raw
  model prose. The frozen-set replay gate stops being opt-in: without
  `--project`, lookout replays up to two recent projects that hold a usable
  set, and when none exists the commit and changeset say the judge itself
  went unreplayed; `lookout protocol` now matches. `.changeset/` is created
  before writing into it.

## 0.31.0

### Minor Changes

- 7bd9716: lookout learns automatically. `check` and `verify-fix` now end by running
  `skills improve` when the project has accumulated enough NEW evidence: three
  new signals, or a single new by-design adjudication (a person wrote a rule
  down; it should not wait). The frozen-set replay gate still decides whether
  an amendment survives, the auto path never spends when the outcome could
  only be an unapplied proposal, and an improve failure is an incident, never
  the run's failure. The spend is visible (narrated, in the event log, and as
  a `learned` field under `--json`), capped by a 24-hour cooldown, and
  declinable three ways: `--no-improve` for a run, `learn: { auto: false }`
  in the config for good, and CI environments never auto-learn. `learn.
threshold` and `learn.cooldownHours` tune it; `lookout protocol` documents
  it.

## 0.30.16

### Patch Changes

- 07fd767: `skills improve` consumes what it is shown and refuses what the evidence
  never asked for. The model sees only signals no pass has seen (the
  watermark stamps every recorded outcome, rollbacks included, so identical
  evidence never pays twice; `--all-signals` replays everything); an
  amendment naming a skill outside the shown signals' attribution is
  refused, with visual-judge and refute-finding licensing each other (the
  frozen replay exercises both); a brand-new skill lands as PROPOSED.md
  instead of the one live write that skipped the gate; a run whose best
  outcome is an unapplied proposal spends nothing unless `--propose` says
  to; and rollbacks record `skill-rollback` incidents so the machine-wide
  log can see an amendment writer failing across projects.

## 0.30.15

### Patch Changes

- 95de292: Signals carry a stable identity and better attribution, and a committed
  watermark (`.lookout/skills/signals-seen.json`) records what an improve
  pass has already been shown, so the same adjudication stops being "new
  evidence" forever. A by-design ruling on a finding the adversarial
  verifier had confirmed now attributes to refute-finding (a person
  overruled the refuter, not the judge); undecidable criteria attribute by
  author (judge-written ones to the judge; code-written derived/universal
  ones stop pretending to teach a skill); and the standalone verify verb's
  report, which nothing read before, feeds verify-acceptance signals.

## 0.30.14

### Patch Changes

- cf9e789: The conformance read fires only on full-scope checks: a route-scoped run
  (`--targets`/`--routes`) skips the source sweep with a reported note, since
  the sweep reads the application's source rather than the captured route and
  a tight fix loop was paying it every iteration; an explicit
  `--max-conformance` is explicit consent and overrides. `check` gains
  `--no-cache` (the judge ledger serves nothing but writes fresh verdicts;
  the conformance reader neither serves nor writes). Full sweeps retire
  conformance cache entries whose files left the tree. A reader refutation of
  an already-open finding, previously paid for and thrown away, now surfaces
  as a disagreement note carrying the ready-to-paste by-design adjudication
  command; nothing is auto-closed. `design-system --audit` says out loud that
  its verdicts warm the cache the next check files from.

## 0.30.13

### Patch Changes

- 1a95a05: Animated views stop re-judging forever. Captures disable CSS animation, so
  an animated view's stored still is usually byte-stable, and when animation
  leaks into pixels the group hash misses on its own; the cache veto
  therefore bought only judge variance while writing ledger entries nothing
  could read. The cache now serves on hash identity alone, the judge prompt
  instead marks such shots as one frame of a moving view, animation
  detection covers state recipes (where spinners actually live) instead of
  only the rest state, and full-scope checks prune ledger entries no current
  capture can reach, so the committed cache stops growing monotonically.

## 0.30.12

### Patch Changes

- f636ed3: Judging scope is pinned to the current config. The capture report
  accumulates across runs, so shots of routes or states removed from the
  config stayed in scope forever, paying capture and refreshing findings
  about screens nobody can reach. They now leave judging scope immediately
  (with a counted note), and an unscoped capture, the one moment lookout
  sees the config's whole intent, retires them from the report; scoped
  captures never prune. Native shots are exempt, and findings on removed
  routes are never auto-closed: they stop refreshing and surface through the
  existing backlog staleness checks for a person.

## 0.30.11

### Patch Changes

- 37d5b33: `check --first` (the UI play button's path) stops on standing findings and
  never says "no issues found" over an open backlog. The walk used to branch
  on newly-filed counts, so a repeat run over an unchanged app re-captured
  every route and printed a clean bill while cache-served findings of open
  issues stood; it now stops at the first route with anything standing,
  walks routes that already carry open findings first (worst severity first,
  so a repeat run costs one route's capture and zero judge calls), reports
  "all already filed" honestly, gives the stopping route's issues their
  placement (issues born on this path never reached the full check's sweep),
  and a clean walk over a non-empty backlog says how much open work it could
  not reach.

## 0.30.10

### Patch Changes

- 20b4a75: Stale placements are recognised and re-derived. The stored record always
  carried the kit name "so a stale placement is recognisable", and nothing
  recognised it: a kit rename, an editability flip, or the placed file
  vanishing now re-derives the placement on the next check, stale ones
  outranking fresh unplaced issues for the cap (wrong advice beats no advice
  to the fix). The path is verified to exist the moment a placement is
  written (a reply naming a ghost file keeps the advice, drops the path, and
  says so), and an issue document whose placed file has since vanished
  annotates the path instead of pointing a fixer at nothing.

## 0.30.9

### Patch Changes

- 6c7de89: Placement slots go to live, locatable work only: the sweep now considers
  open issues alone (fixed, by-design and archived ones no longer spend the
  cap) and skips code-channel issues, whose documents already carry the exact
  path, line and symbol. Failures are counted and reported instead of
  silently consuming slots (an all-fail sweep used to print nothing while
  spending money), the run summary carries the cost, and `--max-placements 0`
  says "off (cap 0)" instead of promising leftovers the cap guarantees will
  never be placed.

## 0.30.8

### Patch Changes

- 173b0f4: A verify-fix pass may no longer rest on unruled acceptance. If the criteria
  verifier dies (it now gets one retry) while the defect looks gone, the run
  refuses the pass: exit 2, nothing closes, no attempt is spent, and the
  unruled criteria are named; a stale ruling earned by another run counts as
  unruled, so passes are earned per attempt. Verifier failures also land in
  the machine-wide incident log instead of an event log the next capture
  truncates. Code-channel issues get their own universal criterion ("the
  oracle that filed this re-read the source") instead of a screenshot claim
  blanket-marked met by a pass that photographed nothing, and each criterion
  carries a note naming its oracle. When the 20-shot cap bites, the criteria
  verifier now sees the most refuting shots first (changed member evidence,
  then uncovered form-factor and scheme pairs) instead of capture order, and
  the truncation is reported.

## 0.30.7

### Patch Changes

- 89820c0: verify-fix closes an AI finding only when that finding's own pixels moved.
  The pixels-moved guard was scope-wide, so a multi-route issue could pass
  when one route was edited while the other's unchanged views were served
  from the judge cache, closing the untouched member on silence. Closure is
  now vouched for per member, at zero model cost, and the verdict note names
  the routes whose findings sat on unmoved pixels. The deliberate cost: a
  member fixed by an earlier unrelated commit blocks at the attempt cap and
  needs a person.

## 0.30.6

### Patch Changes

- bf452be: The adversarial verifier now reaches every AI finding. The old boundary
  (critical/high plus six quality-band categories) contradicted the rubric's
  own severity ladder and left design-parity, color-scheme and responsive
  findings unrefuted at medium and low. With the boundary gone: the refuter
  retries once and records an incident when it fails twice, a refuter
  subprocess failure no longer throws the judge's cached work away, cached
  groups holding never-refuted findings are repaired on the next run by a
  capped refute-on-read pass, and the frozen regression set can harvest
  verified mediums (lows stay out deliberately: the most judge-variant claims
  would make the improve gate flaky).

## 0.30.5

### Patch Changes

- a6d3533: The judge cache's identity now covers every design input: a route's hand-off
  image contributes its bytes to the view group's hash (swapping the PNG
  re-judges the views that point at it), and handoff.md joins the prompt hash
  (editing it re-judges what it could have changed). Groups without designs
  keep their existing hashes, so no cache is invalidated by the upgrade
  itself. The prior-findings block stays out of the key, now documented at the
  store: it is a naming aid, and adjudications are enforced at merge.

## 0.30.4

### Patch Changes

- c30f72b: The conformance cache's identity now covers the composed skill text and the
  model, not just the skill version and kit exports. A project amendment with
  no version field changes the prompt, and a `--model` flip changes whose
  verdict it is; both previously left every cached verdict standing, and both
  now discard the cache whole, which is the same bargain the judge ledger
  already makes.

## 0.30.3

### Patch Changes

- 4e41e5a: verify-fix can no longer close a conformance finding without the oracle that
  filed it re-firing. The code ruling now resolves the design system the same
  way filing does (config declaration applied), so a kit that exists only as a
  declaration no longer files on `check` and auto-passes on `verify-fix` having
  read nothing. A kit that stops resolving refuses the pass and points at
  by-design adjudication instead of clearing every open finding. Members with
  no recorded provenance are re-read by the conformance skill rather than
  cleared by scanner silence, members naming no source file refuse to clear,
  and `verify-fix --model` now reaches the conformance re-read.

## 0.30.2

### Patch Changes

- 8fe2f89: The MIT grant now covers the source as well as the published package.

  The LICENSE that shipped in the tarball carried a carve-out saying the licence
  applied to the compiled output alone and that the repository stayed all rights
  reserved. It was generated at pack time by `tools/licensegen` and gitignored, so
  that a LICENSE file at the repository root could not make a forge read the whole
  project as MIT.

  That split is gone. LICENSE is a plain MIT grant, committed at the root, and npm
  packs it into the tarball on its own without being listed in `files`, so the
  generator and the `prepublishOnly` step that ran it are both removed.

## 0.30.1

### Patch Changes

- eee4893: A pre-fix frame is frozen once per VIEW rather than once per issue, so a view an
  issue only gains later gets a picture of its own defect too.

  An issue grows when the same root cause turns up on another route, form factor
  or scheme. The first freeze wrote every view it could see and then declared the
  issue done, so a member that joined afterwards had no frame, and since the card
  draws the frozen pair rather than the live store, that view simply did not
  appear on it. Each view is now frozen at the save that files the finding on it,
  and a view already frozen is never re-copied, so the original defect is still
  what the pair compares against.

## 0.30.0

### Minor Changes

- d512b51: Every issue now keeps a pre-fix screenshot, and the card shows the pre and post
  fix pair instead of a strip of the store's current copies.

  The new capability is the guarantee: an issue is frozen by the save that files
  it, so a picture of the defect exists from the moment lookout finds it rather
  than from the moment somebody first asks it to verify a fix. Before this, only
  `verify-fix` froze anything, so an issue nobody ever asked lookout to rule on had
  no picture of itself anywhere. The evidence store keeps one file per view and
  overwrites it on every capture, which meant the card's "Where lookout saw it"
  strip became a picture of whatever replaced the defect at the next run, under a
  heading claiming otherwise.

  What changed, in the places you will notice:

  - The card's evidence section is now "Pre and post fix": one pair per view,
    frozen frames on both sides, with the missing half saying which case it is
    ("no post-fix frame yet" on live work, "no post-fix frame kept" on a settled
    issue nothing could copy). The pairs wrap rather than scrolling sideways, so a
    second pair is never hidden off the edge of the card. "On disk" lists the
    frozen frames, because those are the paths that stay put.
  - The issue folder's `img/` is a copy of the frozen frames, in `img/pre/` and
    `img/post/`. It used to re-copy from the store whenever the store was newer,
    so the folder documented as "the screenshots it was filed against" quietly
    became the fixed screen. Existing folders migrate: the old flat pile moves into
    `img/pre/`, since those are the older picture. `Issue.md` points at the frozen
    frames too.
  - `lookout backlog check` reports an issue with a screenshot behind it and no
    pre-fix frame, so the guarantee is checked rather than assumed.

  An issue that has already spent a fix attempt is never backfilled: something has
  claimed to change that screen since it was filed, so its store frames are of
  unknown vintage, and filing them as the defect would be a picture of somebody's
  fix under the wrong label. `verify-fix` follows the same rule now instead of
  freezing whatever it happens to find.

## 0.29.15

### Patch Changes

- b94d42e: The page's shell is read from disk per request instead of being held in memory
  from startup.

  Every other page asset was already served this way, with `no-store`, so that a
  rebuild during a fix session reaches an open tab on a reload. The shell was the
  one part that was not: it was a template literal compiled into the server, so a
  long-running `lookout ui` kept asking for whatever stylesheet names it had
  loaded with. Renaming one left the running server requesting a file the rebuild
  had deleted, and the page came back completely unstyled while the checkout, the
  build, the type check, the linter and the tests were all correct and green.

  The markup now lives in `src/ui/client/shell.html`, beside the stylesheets and
  copied into `dist` with them, and `page.ts` reads it on the way out. A missing
  shell answers with the name of the file it could not find rather than a blank
  screen, the same way a missing stylesheet already did.

## 0.29.14

### Patch Changes

- aec2450: The gate for anything the page renders is now a tool rather than a paragraph
  telling you to build one. `tools/ui-check` has four commands: `fixture` builds a
  throwaway project with something in every part of the page (an open issue with
  evidence and criteria, one adjudicated, a history of lookout amending its own
  instructions including a rollback, a frozen set, an incident log, a reverted
  heal and a checkout with two that stuck), `serve` points the ui at it, `shots`
  captures eight views across both colour schemes and a narrow viewport, `diff`
  compares two captures and crops whatever moved, and `drive` runs sixteen
  interaction checks.

  The fixture backdates its evidence so the page's one relative clock renders in
  whole days. That is what makes the comparison binary: two captures of unchanged
  code come out ALL IDENTICAL and exit 0, rather than differing by a hundred
  pixels of digits and leaving the reader to decide whether that mattered. Both
  directions were checked: a six-pixel padding change is caught as 4.4% of the
  board and a non-zero exit.

  Development only; `tools/` is not published.

## 0.29.13

### Patch Changes

- e8fe67d: Split `src/design/detect.ts` into the jobs it was doing: reading the directory
  tree (`detect-tree`), resolving which kit a repository has (`detect-kits`),
  looking for controls the application built for itself (`detect-handrolls`), and
  the pass that assembles an inventory out of the three. Behaviour is unchanged,
  verified by `lookout design-system --audit` producing output identical to the
  run before the split.

  With this the `max-lines` debt list in `eslint.config.mjs` is empty: no file in
  the repository is exempt from the 300-line ceiling any more, and `CLAUDE.md` no
  longer describes pins that do not exist.

## 0.29.12

### Patch Changes

- fe74dfe: Split `src/design/conformance.ts` into the three jobs it was already doing, and
  drop it from the debt list in `eslint.config.mjs`: choosing which files are
  worth a model's attention (`conformance-candidates`), putting one batch to the
  model and refusing to believe the reply (`conformance-batch`), and running the
  sweep around both. Behaviour is unchanged, verified by running
  `lookout design-system --audit` fresh and cached against a fixture project.
- fe74dfe: The page's stylesheet follows its script. `client/shell.css` carries the colour
  tokens, the rail and the run controls; `client/board.css` carries a card and
  everything inside one. They are edited for different reasons, and after the
  script became nine modules the single stylesheet was the last file two people
  doing unrelated UI work would have collided in.

  Also documents a verification step that was missing: the page's assets are files
  the build copies, so a build that stopped copying them would pass every gate and
  serve a blank page to anyone who installed the package. Packing the tarball and
  running it from a throwaway install is now written down as the check, and was
  run: `npm pack` ships all eleven client files, and the ui served from the
  installed binary passes the same sixteen interaction checks, serving its script
  byte for byte from the built module rather than transpiling it.

## 0.29.11

### Patch Changes

- 85da4fb: `judge/engine` held three unrelated jobs. The subprocess contract moves to
  `judge/claude`, which is what every AI capability lookout has actually shares:
  the judge, the refuter, the acceptance verifier, the conformance reader, the
  skill amender and the healer all ask different questions the same way, and now
  there is one place that knows how a reply is unwrapped. View groups and batching
  move to `judge/grouping`, since that is the unit the rubric compares within, the
  ledger caches by, and a batch is one of.

  What is left is the prompt and the reply contract. `engine` re-exports the rest,
  so nothing that imported it changed, and it comes off the size-ceiling exemption
  list: only the two design modules remain pinned.

## 0.29.10

### Patch Changes

- 710702b: The test suite no longer records incidents into the operator's home.

  `recordIncident` writes under `LOOKOUT_HOME`, which falls back to
  `~/.lookout`, and the tests that exercise judge ingestion never set it. Every
  run therefore appended real-looking failures to the real log: 585 of the 599
  lines in one operator's `incidents.jsonl` were fixtures, carrying the project
  names `proj` and `demo` from the test helpers. The learning area of `lookout ui`
  reads that log to answer "what has actually gone wrong with lookout", so the
  page was reporting the test suite's own manufactured failures back to the person
  running it.

  A `bunfig.toml` preload points `LOOKOUT_HOME` at a throwaway directory before
  the first test file loads, so this holds for every test rather than for the
  tests that remembered. A hook in the preload puts that home back whenever a test
  clears the variable, since an unset `LOOKOUT_HOME` is the operator's real one and
  a teardown that tidied up after itself used to hand the real home to everything
  that ran after it.

  `test/home-isolation.test.ts` keeps the guarantee honest. It fails if the home
  is ever the operator's, and it fails if the run was started from a directory
  where `bunfig.toml` is not found, which is the one way the preload can silently
  not apply.

- 10d63ea: `verify-fix` gives up the last thing that was not a ruling: gathering the
  evidence. `verify/evidence` re-captures and re-judges the issue's own routes,
  folds the result into the backlog, and works out which screenshots actually
  moved. That last part is computed once and handed to both the verdict and the
  acceptance criteria, rather than derived twice, because it is the load-bearing
  guard: a shot with no baseline is not evidence of change but evidence of
  nothing, and counting it as changed once let a cleaned evidence directory
  satisfy the rule that nothing may pass on unchanged pixels.

  The verb is now under the size ceiling and comes off the exemption list. Only
  `design/detect`, `design/conformance` and `judge/engine` remain pinned.

## 0.29.9

### Patch Changes

- 13eb3e3: `lookout skills` follows the rule the repo now states: a verb dispatches, it
  does not hold the work. `skills/history` is lookout's record of what it did to
  its own instructions and the lock it holds while doing it, `skills/replay` is
  the gate that judges the frozen set through the real pipeline, refuter included,
  and `skills/amend` is the only part that writes.

  The verb keeps its five subcommands and re-exports the names other modules have
  always imported from it, so nothing else changed.

## 0.29.8

### Patch Changes

- a63504c: `backlog/lib.ts` was 742 lines carrying five unrelated jobs behind banner
  comments. Each banner is now a file: `backlog/fingerprint` (the dedupe identity,
  axes only and never prose), `backlog/ingest` (the three channels mapped into one
  shape), `backlog/merge` (the reopen and suppress state machine, and the status
  transitions that are its other half), `backlog/check` (whether the file still
  tells the truth), and `backlog/report` (the counts and the deterministic
  markdown).

  `lib.ts` keeps the shapes, which is what most of its thirty-one import sites
  want, and re-exports the rest, so nothing that imported it had to change. Each
  name is still defined in exactly one place. It comes off the size-ceiling
  exemption list.

- a63504c: Rename the directory holding the frames either side of a fix from
  `evidence/frozen/<id>/` to `evidence/fix-frames/<id>/`. `lookout skills freeze`
  already keeps a frozen regression set, and two unrelated things wearing one word
  is how somebody deletes the wrong directory. Nothing carries over: the frames
  are gitignored evidence, and an issue with none simply shows the strip it always
  showed.

  Document what a fixed issue keeps, in all three places somebody looks: the
  README, the contract `lookout protocol` prints, and the skill an agent reads
  before driving it.

## 0.29.7

### Patch Changes

- 4b24b13: The board module now matches the rule it was written to encode: outstanding work
  is state, not narration. `report/board-durable` reads the state (the backlog,
  each cluster's attempts, the evidence store's mtimes), `report/board-live` reads
  the narration (what the run in flight has said about one issue), and
  `report/board` is the join plus the two tallies.

  The contract moved out too, to `report/board-types`, which imports nothing that
  touches a filesystem. The page's client modules import those shapes as types, so
  a leaf module is what keeps a browser bundle from dragging in the code that
  produces them. It is also the file that changes when the board grows a field,
  which two sessions should be able to do without meeting inside the builder.

  `report/board.ts` re-exports the contract, so nothing that imported it had to
  change. It is now small enough to come off the size-ceiling exemption list.

## 0.29.6

### Patch Changes

- 2eadedc: `verify-fix` gives up two pieces it should never have held. Ruling a code-channel
  defect is `verify/code`: those findings come from reading source, not pixels, so
  re-capturing proves nothing about them and they are ruled by re-reading the
  code. Ruling the acceptance criteria is `verify/acceptance`, where each source
  is decided by the thing that can decide it: the deterministic checks rule their
  own, the pixel hashes rule the re-capture guard, and the judge-authored ones get
  an independent look at the new screenshots.

  The verb keeps what is actually its job: work out what changed, rule, and record
  the attempt.

  No test calls `verifyFix`, so this was verified by running it: a real re-capture
  and re-judge of an issue's own routes, the load-bearing guard refusing to pass
  on byte-identical screenshots, four acceptance criteria ruled from three
  different sources, and the attempt recorded.

## 0.29.5

### Patch Changes

- 3e2da2a: Two guardrails, so the restructuring holds.

  A `max-lines` ceiling of 300 code lines per source file, with comments and blank
  lines not counted: the prose in this codebase is the point, and a rule that
  punished it would be a rule against explaining things. The seven files that
  predate the ceiling are pinned in `eslint.config.mjs` at the size they were, so
  each may be split and none may grow.

  A repo `CLAUDE.md` saying where a change goes, what the tooling enforces, how to
  verify the two kinds of change that green gates do not cover (anything the page
  renders, and any verb, since the suite covers modules rather than compositions),
  and how to work in a checkout several sessions share.

## 0.29.4

### Patch Changes

- 4b5769f: `lookout check` was one 320-line function that captured, partitioned the cache,
  judged, verified and reported. Its own comments numbered those steps 1 to 6,
  which is where it has now been cut: `check/scope` (what this run is looking at),
  `check/plan` (what still needs judging, by which rules, and what is already
  open), `check/batches` (the judging and the refuter behind it), and
  `check/outcome` (the ledger and the report). The verb is the order they run in.

  No test called `runCheck`, so the split was verified by running the verb against
  a real page: a full capture and judge, a second run served entirely from the
  ledger cache, and the empty-scope guard.

## 0.29.3

### Patch Changes

- cbb93cc: The page's script is now nine modules instead of one. `board` renders a card,
  `filters` owns the headline numbers, `tools` owns which editor an issue opens
  in, `settings` owns the panel, `shell` owns the frame and the rail, `state`
  holds what the page knows between polls, and `main` is the poll, the clicks and
  the boot order. Two people working on the card and on the settings panel no
  longer edit the same file.

  The dependency graph is acyclic, which took one deliberate inversion: several
  actions have to redraw the page when they finish, but the poll that redraws it
  needs every renderer, so the loop registers itself as the refresher at startup
  rather than being imported by the modules that trigger it.

  Fixes a bug this work surfaced: the "Showing only ..." bar had no `[hidden]`
  rule, so an author `display:flex` beat the browser's own hiding. Clearing a
  filter left the bar on screen over a board showing everything, and its margin
  took fourteen pixels off every page load. The two neighbouring rules had the
  same guard already; this one was missing it.

## 0.29.2

### Patch Changes

- f471626: The page's front end is real source now. Its styles and its script used to live
  inside a template literal in the server, which meant nothing in the build ever
  read them: no type check, no lint, and a stray escape reached the browser as a
  syntax error with every gate still green.

  The styles are `src/ui/client/*.css`, served as files. The script is a set of
  ES modules under the same directory, type-checked against the very types the
  server serialises: `/api/status` now has a written-down `StatusPayload`, the
  settings panel a `SettingsView`, and the tool list a `ToolChoice`, so a payload
  field that changes shape fails the build instead of the page. Type-checking the
  client immediately found two latent bugs, both places where an optional field
  was guarded on a copy and then dereferenced.

  Running from a checkout needs no build step: the server transpiles the client's
  TypeScript on the way out, which lookout can do for free because it already runs
  under bun. An install serves the emitted modules the build ships in `dist`.

  Two lint rules keep the boundary honest, both verified to fire: client code may
  not touch node globals, and may not import a server module except as a type.

## 0.29.1

### Patch Changes

- 3884d8a: `lookout ui` was one 1830-line file holding the HTTP server, the router, the
  thumbnailer, the child process that runs a check, the board cache and the whole
  front end. Any change that was UI-shaped at all had to open it, which made it
  the file two sessions were most likely to collide in: 28 of the last 200 commits
  touched it.

  It is now the verb alone, with what answers each request beside it under
  `src/ui`: `routes` (which handler serves what), `payload` (the board and the
  self-improvement record, and their caches), `evidence` (screenshots and
  thumbnails), `run` (the check the play button starts), `project` (where lookout
  is pointed and whether its targets answer), `session` (the state one server
  process carries), and `page`. `ui-settings` and `ui-learning` moved alongside as
  `ui/stored-settings` and `ui/page-learning`.

  Behaviour is unchanged: the served page renders pixel for pixel as before across
  both areas, both colour schemes and a narrow viewport, the only difference being
  a relative clock that had advanced.

## 0.29.0

### Minor Changes

- 7f441cb: Minor justification (new public capability): `lookout ui` now has a second area
  showing what lookout has changed about itself, reached from a new icon rail down
  the left edge, and a new `/api/learning` endpoint behind it.

  lookout could already amend its own instructions (`skills improve`) and fix its
  own source (`self-heal`), and both wrote down what they did somewhere nobody
  looks: a JSONL file under `.lookout/skills/`, a reverted diff under the
  operator's home, a commit in a checkout the reader may not have open. The area
  gathers that record. Its instructions: every skill and the version this project
  judges at, which ones this project has amended, proposals nothing could grade,
  the frozen screenshots gating the next amendment, and every amendment applied,
  rolled back or proposed, a rollback carrying the settled verdict that killed it.
  Its own code: the failures lookout keeps hitting, the heals a gate reverted with
  the gates that failed, and the commits that stuck.

  `skills improve` now takes a lock while it runs, the way `self-heal` already
  did. It earns its place twice: two improves at once would restore each other's
  "before" and silently drop an amendment that had already passed the gate, and
  the lock is also the only honest live signal, since neither verb writes its
  record until it has finished deciding. The rail's dot reads it.

## 0.28.0

### Minor Changes

- 10f3fb8: Minor justification (new public capability): settled issues can be filed away.
  A done issue's card offers to archive rather than to open in a coding tool,
  which was the wrong thing to offer: there is nothing left to hand a fix session
  about a defect lookout has already confirmed gone.

  Archiving records why it happened and moves the issue's folder to
  `.lookout/issues/archive/<id>/`. The record decides and the folder follows on
  the next save, so the two cannot drift; readers that only have an id find the
  folder wherever it is. A `fixed` archive is never described as one somebody
  adjudicated intentional, which is the older meaning of the same status.

  Two guards. Archiving refuses while any finding is open, because hiding live
  work is the one thing an archive must not do. And an archived issue whose defect
  comes back un-archives itself, folder and all, on the save that reopens it.
  Archived cards carry a restore button; an archive with no undo is a trapdoor.

## 0.27.0

### Minor Changes

- 2e38b80: Minor justification (new public capability): an issue now carries the fix as
  well as the defect. The card links the commit it landed in on the project's own
  forge, and shows the frames either side of the fix rather than a strip of
  screenshots that quietly became pictures of the fixed screen.

  The commit link is string work over `git remote`, memoised per project: GitHub,
  GitLab, Bitbucket and Azure get their exact URL shape, an unrecognised forge
  gets the near-universal `/commit/<sha>` with its host shown beside it, and a
  checkout with no remote shows the sha and says there is nowhere to send you.
  "Fixed in" is a verdict lookout reached; "Claimed at" is an attempt still open.

  The frames are the part that needed new retention. The evidence store writes
  each view back to the path it came from, so `verify-fix` proving a defect gone
  also overwrote the only picture of it, and the card kept a strip labelled "where
  lookout saw it" that was by then the fixed screen. `verify-fix` now freezes the
  defect's frames before it re-captures, once per issue so later attempts still
  compare against the defect as filed, and freezes the cleared frames when a
  ruling passes. The card pairs them per view under "The fix", and an issue with
  no frozen frames stops claiming a settled screenshot is where the defect was.

## 0.26.1

### Patch Changes

- bbb08eb: Harden the conformance pass after its first end-to-end run: `--max-conformance
0` now reads nothing rather than everything, a claimed symbol that is not an
  identifier is rejected instead of matching the first declaration in the file,
  batches run two at a time rather than strictly in series, and the reader's
  account of a component is punctuated as sentences because it lands in the issue
  somebody reads.

## 0.26.0

### Minor Changes

- 6c7744d: Minor justification (new public capability): a conformance pass that reads
  whether an application is actually built out of the component kit it has, plus
  the flags that drive it: `lookout design-system --audit`, and `--no-conformance`
  / `--max-conformance N` on `lookout check`.

  Having a kit and using it are different facts. The scan that filed hand-rolled
  duplicates until now matched names and only looked at files importing the kit
  nowhere, so it never saw the common case: a screen that imports the kit for its
  text and then builds a button out of a styled `div` in the same file.

  The new `kit-conformance` skill reads those files with the kit's real export
  list in hand, adds what the scan cannot see and refutes what it got wrong.
  Nothing it says is taken on trust: a claim names a file, a symbol and a line,
  the symbol is looked up in the file, and a kit component the kit does not export
  is dropped rather than repeated. Verdicts are cached per file, keyed on the
  file's bytes plus the skill version and the kit's exports, so a second run over
  unchanged files costs nothing.

  Two other things changed with it. Kits are now read rather than guessed at, so
  `design-system` reports what a kit actually exports and a hand-rolled control the
  kit has no equivalent for is filed as a gap in the kit instead of claiming a
  duplicate of a component that was never there. And `verify-fix` rules a
  skill-found finding by asking the skill again about that file, because the scan
  is exactly what could not see it in the first place.

## 0.25.0

### Minor Changes

- e01a6c5: Find the project's design system, and say where a visual fix belongs.

  Minor because this adds user-visible capability rather than changing existing
  behaviour: a new verb (`lookout design-system`), a new configuration block
  (`designSystem`), a new skill (`design-placement`), and a new finding channel.
  Nothing existing changes shape for a project without a design system, where the
  scan reports none and every document renders exactly as it did before.

  A defect is found on a screen and fixed in a component, and in any project with
  a component kit those are rarely the same file, often not even the same package.
  A fix session that does not know this patches the screen: the kit stays broken
  for every other consumer, the screen gains an override that will drift, and the
  next person to touch the component cannot see why it is special.

  So lookout now reads the repository and works out what it is built from,
  deterministically, from manifests and directory layout rather than by asking a
  model. It resolves a design system's own repository, a workspace-local kit, a
  vendored kit such as shadcn/ui, and an installed one, and records the bit that
  decides everything downstream: whether the kit's source is this repository's to
  edit, or an installed dependency whose fix belongs in the application's use of
  it and never in `node_modules`.

  Every issue filed in such a project gains a "Where this belongs" section naming
  the file to change, why there rather than the other place, how many other
  callers a kit change would reach, and what else it moves. That answer comes from
  `design-placement`, lookout's sixth skill and the first allowed to read the
  target repository, read-only and in a pass kept separate from judging so that
  the visual judge stays as isolated from a repository's own instructions as it
  has always been.

  lookout also now files what it can see without a screenshot. A control an
  application hand-rolls out of raw elements, where its kit already provides one,
  is a real defect no photograph can show, so it is filed on the previously
  reserved `code` channel and ruled by re-reading the source. `verify-fix` closes
  it on evidence exactly like any other issue: the fixer still does not get to
  grade their own work.

  New configuration, for a kit the scan cannot name on its own:

  ```ts
  designSystem: {
    name: "House",
    packageRoot: "../packages/ui",
    componentRoots: ["../packages/ui/src/components"],
    importPrefixes: ["@house/ui"],
  }
  ```

## 0.24.0

### Minor Changes

- 6177619: `lookout ui` gets a settings panel, and a base URL that moves a config's targets
  instead of discarding the config.

  New user-visible capability. Configuring lookout was previously something the
  Play button did on its way past: clicking it opened a folder dialog, and the
  answer was forgotten when the server stopped. There was also no way to say
  "this project, but the app is on a different port" at all.

  **A cog beside Play.** It opens a panel showing where lookout is pointed, every
  target the config declares with its route count, and whether each one answers
  right now. A wrong port is visible before a run is spent on it rather than
  after. Play only ever runs.

  **Play is grey until something is configured**, and green when it would really
  work. A green "go" that can only produce an error is a lie told by a colour.

  **Settings are remembered** in `~/.lookout/ui.json`, so `lookout ui` with no
  arguments comes back pointed where you left it. The server also starts
  unconfigured now instead of exiting, which it had to: the one screen that can
  fix an unconfigured project could not previously be opened until the project was
  already configured.

  **New `--base-url` flag**, for the CLI as well as the panel. It overrides the
  origin of every target while keeping the config's routes, viewports, state
  recipes and sign-in hook. This is deliberately not `--url`, which short-circuits
  the config file entirely and captures "/" of a single synthetic target; that is
  right for pointing lookout at something it knows nothing about, and wrong for a
  configured project whose dev server came up somewhere else today. A target
  mounted under a path keeps that path, since the path is where the app lives and
  the origin is which machine it is on.

## 0.23.2

### Patch Changes

- f8b4348: The last traces of the projects lookout was built against are gone, and two
  stale package names are corrected.

  A follow-up to the earlier sweep, from a second audit pass over the whole tree.

  - `/components/button` was the only route example on lookout's public type
    surface (`RouteDef.path`, and twice in the capture store), which ships in
    `dist/*.d.ts` and therefore shows in every consumer's editor tooltips. It is
    a design-system docs route and made lookout read like a design-system tool.
    Now `/settings` and `/settings/profile`.
  - Test fixtures collectively sketched a real deployment: an OAuth2
    `login_challenge` parameter, an identity server's `/identities` admin route,
    and four real ports. Individually harmless, together a map. Renamed to
    neutral values; the tests assert on structure, so nothing else changed.
  - The generated MIT LICENSE named `@nannier/lookout`, a package that does not
    exist. The grant in the published tarball now names the real one.
  - `bun.lock` still carried the pre-rename scope, disagreeing with
    `package.json`. Aligned.
  - `.gitignore` now covers `.claude/`, so local agent settings cannot be
    committed into a public repository by accident.

- b6268f1: Fixes a broken client script in `lookout ui`, and adds the test that would have
  caught it.

  The page's JavaScript lives inside a template literal, which means neither
  `tsc` nor `eslint` ever sees it. A `\n` written in that region is consumed by
  the template literal itself and emitted as a real line break inside a quoted
  string in the served script, so the browser threw on load and the entire page
  rendered blank while every build gate stayed green. That is exactly what
  happened, and it is why the page looked empty rather than merely unhelpful.

  The escape is fixed, and `test/ui-page.test.ts` now compiles every script block
  in the page with `Function()`, the same parse the browser does on load and the
  one thing the build never did. Verified by reintroducing the bug and watching
  the test fail.

## 0.23.1

### Patch Changes

- 41cbec8: lookout no longer carries knowledge of the projects it happened to be built
  against, ahead of being open sourced.

  It is a project-agnostic tool, but its comments, help text and agent skill had
  accumulated references to the author's own private repositories: what they are
  called, how many routes they have, which orchestration tool starts them, and
  where they sit on one particular machine. None of it changed behaviour, and all
  of it would be meaningless or misleading to anyone else reading the source.

  - The agent-facing skill listed "wired projects" by name with route counts and
    sign-in details, named a private orchestration tool, and hard-coded a home
    directory as the install path. It now says to read `.lookout/config.ts` and
    `lookout targets` for what a project targets, and to follow whatever
    `startHint` that project sets.
  - `lookout --help` used a private app's port and route as its examples
    (`--targets docs --routes /components/button`). It now shows examples a new
    user can recognise.
  - `NativeAppConfig` documented its deep-link scheme and bundle id with a real
    private app's identifiers; both are now generic.
  - Several module headers credited techniques to a named private project. The
    techniques and the reasoning are kept; the attribution is gone.
  - Two release-workflow comments referenced another repository's pipeline.

  No behaviour changes. Verified by grepping the whole tracked tree for every
  project, tool, host and path name involved and finding nothing left.

- 7cdb837: The UI now tells you why a run did not happen, instead of going quiet.

  Clicking Play, picking a folder and getting nothing back was three separate
  defects, each turning an explanation lookout already had into silence.

  **The message was erased before it could be read.** Every failure path wrote its
  reason into the `where` element, and the polling loop overwrote that same element
  with the project path on its next tick. One element, two writers, and the path
  always won, so "no .lookout/config.ts in ..." appeared for a fraction of a second
  and vanished. Notices are now held as state and rendered in preference to the
  path, with their own styling: the path is clipped to one right-to-left line
  because a path is read from its tail, while a message wraps and reads normally.

  **A run that died said nothing.** The check was spawned with its output discarded
  and only an `error` handler attached, which fires when a process cannot be
  launched and never when it exits non-zero. A run that started and died a second
  later left the page idle and blank. Its stderr is now kept and an `exit` handler
  records a non-zero code, surfaced through `/api/status` and shown on the page.
  Exit 1 is not treated as a failure: that is findings, which is an answer.

  **Nothing checked the target first.** The UI spawned a run before asking whether
  the app was reachable. It now probes with `preflight` and refuses with a reason
  naming the target, its status and its `startHint`, rather than starting a run
  that dies on `requireUp` moments later with its output thrown away. The wording
  is shared with the CLI through a new exported `downReason`, so both say the same
  thing about the same state.

## 0.23.0

### Minor Changes

- 8d927b2: The contact sheet is back: `capture`, `check` and `verify-fix` composite every
  shot into one labelled image again.

  Restored user-visible capability. The sheet went out as collateral when auto mode
  was removed, and the README kept promising it: a session driving lookout could
  not see what lookout saw without reading a dozen full-resolution screenshots,
  which costs more context than the findings do.

  A view's dark and light captures sit side by side, because that is the comparison
  the rubric cares about most; tiles are cropped from the top so a tall full-page
  screenshot still shows its above-the-fold region at a readable scale; and tiles
  carrying findings are marked with the count, so `check` and `verify-fix` produce
  a sheet that says where to look. The full-resolution paths are still printed
  beside it for close reading, and the judge never sees the sheet: it judges the
  originals, because a downscaled crop would hide the defects it is looking for.

  `capture` writes `contact-sheet.png` in the evidence directory, `check` writes
  the same with defect tiles marked, and `verify-fix` writes
  `verify-<issue>.png` for the scope it re-captured. The path is printed and
  appears as `contactSheet` in `--json` output. A sheet that cannot be built (an
  image that will not decode, sharp unavailable) is skipped: it is a convenience,
  and it must never fail a run that captured evidence and judged it.

  This also clears the debris the removal left behind: an orphaned doc comment, an
  uncalled helper, and a findings-per-shot map that was computed and never used.

## 0.22.2

### Patch Changes

- 3f31107: The adversarial pass now follows the risk rather than the severity alone, and is
  given the evidence its hardest cases need.

  Severity says how much a defect costs if it is real. It says nothing about how
  likely the judge was to be wrong, and those are different questions. Refuting
  only critical and high findings therefore left the design-quality categories
  unchecked, which is exactly backwards: a claim resting on a named principle
  ("nothing for the eye to land on first") is the judge's most valuable output and
  its most easily argued into existence, while a low-severity claim about broken
  copy is either in the image or it is not. `hierarchy`, `composition`, `spacing`,
  `typography`, `alignment` and `consistency` are now refuted at every severity,
  alongside critical and high as before.

  The refuting skill was extended to ask the question that band needs: is the named
  principle actually violated here, or is this a preference wearing a principle's
  clothes? It refutes a finding that cannot point at a visible consequence, one
  that restates the project's design language as a fault, and one resting on a
  measurement, since these screenshots cannot be measured.

  The refuter is also given the whole view group rather than one image. The rubric
  has the judge compare a view's dark and light captures and its form-factor
  progression, so a colour-scheme or responsive finding is a claim about that
  comparison, and the refuter was handed the single shot the finding was filed on
  and told to lean refuted when uncertain. The findings that needed the most
  evidence were getting the least, and dying for want of the partner shot that
  would have settled them either way.

  One narrower correctness fix: a finding only counts as verified when the verifier
  explicitly says `confirmed`. Any other verdict, a hedge, a word outside the
  contract, or no row at all, now leaves the finding standing but unverified, which
  is what actually happened. It previously counted as verified whenever any row
  came back.

## 0.22.1

### Patch Changes

- ce37e99: The judge is now shown the two things lookout already knew and kept from it.

  **Deterministic signals.** Every shot carries the results of the checks that run
  before judging: the accessibility rule that fired, the element measured
  overflowing its container and by how much, the errors the page logged. None of
  it reached the judge prompt. Each shot in the manifest now carries a compact
  `signals:` line, capped at the first few, with the rubric telling the judge what
  they are for: they are the one part of this pipeline that is a real measurement,
  so they localize and corroborate, but they are not to be restated as findings
  (lookout has already filed them) and their absence is not evidence a view is
  clean. This is precise information a model cannot produce for itself, computed
  already, previously discarded.

  **Findings already open on the view.** The `attribute` on a finding is free text
  the judge writes, and it is half of both the fingerprint and the cluster key. The
  same defect coming back as `dark-theme-stuck` instead of `theme-not-switching`
  therefore minted a second issue, split the attempt history across two, and made
  the first look like it had drifted away. The prompt now lists what lookout has
  open on the views in the batch and asks the judge to reuse the category and
  attribute when it files the same defect again. Absence still reports a fix: the
  list is explicitly not a claim that those defects are still there.

## 0.22.0

### Minor Changes

- 4b95301: The judge now rules on design quality against named best practice, and stops
  asking itself for measurements it cannot take.

  New user-visible capability: findings about hierarchy, typographic rhythm,
  spacing as a system, whitespace, affordance, restraint and whole-view
  composition, under a new `composition` category. The rubric previously drew one
  line, "craftsmanship, not taste", which read as principled restraint but threw
  away the judgment a vision model is best at. It solicited pixel-precision claims
  (`alignment` "edges that should share a line", `typography` "baseline wobble",
  `spacing` "double margins") that models confabulate, while forbidding the
  holistic reading they are genuinely good at.

  The rubric now sorts what it could say into three bands. **Execution defects**
  (broken, illegible, overlapping, clipped) are filed without argument.
  **Design quality** is filed on one condition: the finding must name the
  principle it breaks and what that costs the person using the screen, which is
  what keeps the band falsifiable enough to verify and to write acceptance
  criteria for. **Product and brand decisions** stay protected: brand palette,
  typeface, corner radius, density, copy tone. lookout still rules on what a
  decision does in context, so a brand colour that leaves text unreadable is a
  contrast defect, but never on the decision itself.

  Two things were cut outright. Anything requiring measurement: the judge is told
  it is reading an image and cannot measure it, so geometry findings are filed only
  when the deviation is visible without looking for it and never quote a pixel
  value. And anything a still image cannot show: `a11y` no longer asks about focus
  order and `states` no longer asks about invisible focus, both of which invited
  the judge to invent behaviour it could not see.

  `composition` is added to the closed vocabulary rather than replacing anything.
  Every existing category keeps its exact name, because a category is part of every
  fingerprint and cluster key in every project backlog, and a rename would orphan
  the findings filed under it. Only the descriptions changed.

  The design hand-off instructions moved to `skills/visual-judge/handoff.md` and
  are carried only when a shot in the batch has a `design:` reference. They were a
  quarter of the rubric and the most nuanced passage in it, and every project
  without hand-offs was paying that share of every judge prompt for rules that
  could never fire.

  The `visual-judge` skill is at version 4. Cached verdicts re-judge on the next
  run, which is correct: they were formed under different rules. A project layer
  under `.lookout/skills/visual-judge/` is unaffected and still applies on top.

## 0.21.6

### Patch Changes

- b12a799: A judge run now says what it actually judged, and one bad batch no longer costs
  the whole run.

  **Skipped shots are no longer cached as clean.** The output contract requires
  every shot to appear in either `findings` or `cleanShotIds`, which exists so a
  reply that quietly skipped one can be caught. Nothing read the result, so a
  skipped shot was indistinguishable from a clean one, and `recordVerdicts` wrote
  its whole view group into the ledger as `clean`. A later scoped re-check then
  served that verdict from cache. `judgeBatch` now returns the shots the reply
  accounted for in neither list, those groups are left out of the cache so they
  are judged again next run rather than remembered as clean, an incident is
  recorded, and the run reports them as `N NOT judged` rather than folding them
  into the clean count.

  lookout does not retry the batch to chase the missing verdict. A retry re-reads
  every screenshot in the group at full cost, while simply not caching is free and
  self-correcting.

  **A failed batch no longer discards the run.** The per-batch workers had no
  error handling and were awaited by `Promise.all`, while the ledger was written
  once after all of them returned. A single timeout or unparseable reply in the
  last batch therefore threw away every batch already judged, and the next run
  paid to judge all of them again. Batches now fail individually: the failure is
  recorded as an incident, reported in the run summary and in `failedBatches` on
  the check outcome, its shots are left uncached, and the remaining batches stand.
  Only a run where every batch failed is an error, because that one judged
  nothing. A refuting pass that fails now leaves its findings standing and
  unverified rather than losing them.

  **One judge call per view group.** Batching packed several small view groups
  into one call to save subprocesses, which quietly broke the cache: the rubric
  asks for one finding per distinct defect on the most representative shot, so a
  defect shared by two groups in the same batch was filed against one of them and
  put the other's shots in `cleanShotIds`, recording that view as clean. The
  prompt unit and the ledger unit are now the same thing. In practice this changes
  little for a full run, where a view group of three form factors across two
  schemes already filled the old default batch; it matters for runs narrowed to
  one scheme or form factor, which is exactly where the packing happened. The
  undocumented `--batch-size` flag is gone with it.

## 0.21.5

### Patch Changes

- 7fca815: The judge cache is now keyed on the instructions as well as the pixels, so a
  cached verdict can no longer outlive the rules that produced it.

  The key was `<viewGroupHash>@v<judgeSkillVersion>@<model>`, which left three ways
  for lookout to serve a verdict formed under rules that had since changed. A
  project `rubric` file edited without bumping its `rubricVersion` past the shipped
  skill's version altered the judge prompt while the key stood still. A
  `config.neverFile` change never touched a version at all, so suppressions could
  be added or removed with no effect on the cache. And the `refute-finding` skill's
  version was never in the key even though what the ledger stores is that skill's
  output, so amending the refuter left every stale verdict standing.

  The key is now `<viewGroupHash>@v<version>@<promptHash>@<model>`, where
  `promptHash` covers the composed judging and refuting instructions as they were
  assembled for that run. Editing a rubric, a `neverFile` line or either skill
  re-judges exactly what it could have changed, and nothing has to be bumped by
  hand. The version stays in the key so it is still readable in `ledger.json`.

  Cached findings also stopped claiming to be verified. A cache hit stamped
  `verified: true` on everything it returned, including findings recorded by a
  `--no-verify` run and the medium and low findings the adversarial pass never
  looks at. The stored flag is now read back as written, so the `(verified)` marker
  in the CLI and the `verified` field in `judge-report.json` mean what they say.

  Existing ledgers re-judge once on the next run, because the key shape changed.
  That is the correct behaviour for a cache whose old entries could not be shown
  to match the current rules.

## 0.21.4

### Patch Changes

- 733c61d: `lookout backlog check` no longer reports every open AI finding as resolved by
  drift.

  The gate the fix loop ends on flags an open finding whose screenshot was
  re-captured in the newest run but which no merge refreshed, on the reasoning
  that it was probably fixed and nobody adjudicated it. It compared each finding's
  `lastSeen` against the newest capture run, but the merge stamped the two
  channels from different id families: deterministic findings got the capture run
  id (`web-…`) and AI findings got the judge's own (`check-…`). Those never match,
  so every open AI finding the judge had re-found seconds earlier came back as
  `open finding not re-found in run web-…; mark fixed or investigate`, the gate
  exited 1 on healthy backlogs, and the real signal (a finding the judge silently
  dropped) was indistinguishable from the noise.

  Both channels are now stamped with the capture run id, so `lastSeen` answers the
  question the check actually asks: which capture run did this finding survive?
  The judge run id is not lost. It stays on the check outcome and in
  `judge-report.json`, and every evidence ref already carries the run its
  screenshot came from.

  Existing backlogs correct themselves on the next `lookout check`, which restamps
  each finding it re-files. A finding that is genuinely gone still reports as
  drift-resolved, which is the point of the check.

## 0.21.3

### Patch Changes

- 33f58a7: `verify-fix` can no longer report a pass for work it did not verify.

  The verb an orchestrating session gates on used to answer `passed`, exit 0, in
  three cases where it had checked nothing. An `--issue` id lookout had never
  heard of (a typo, or one carried over from another project) read as a fix
  confirmed, so the session recorded a verification that never ran. An issue whose
  findings were all `blocked` reported success instead of the exit 3 that exists
  to stop it being dispatched again. And an issue already `fixed` or `by-design`
  claimed this run had passed it.

  Those four cases now answer separately. An unknown id, or an id whose findings
  have gone, raises an operator error and exits 2 with a hint about where ids come
  from. A blocked issue exits 3 and restates the recorded reason. An issue already
  adjudicated exits 0 with the verdict `already-adjudicated`, which says what is
  true: there was nothing here to verify.

  Two guards that decide a verdict were also leaking.

  A finding somebody ruled `by-design` under the issue's own cluster key re-fired
  on every capture, because an intentional defect is still there by definition. It
  was counted as the issue's own defect persisting, so the issue could never pass
  however well the real defect had been fixed, and was then blocked with a reason
  claiming a defect persists that somebody had already ruled intended. The merge
  suppressed these; the verdict now does too.

  The pixels-moved guard, which stops judge variance alone closing a real defect,
  switched itself off whenever `.lookout/evidence/` had been cleaned. Its baseline
  came only from the capture report living in that gitignored directory, and an
  empty baseline made every fresh screenshot look changed. It now falls back to
  the evidence hashes in the committed `backlog.json`, which outlive the pixels,
  and a shot with no baseline from either source is no longer counted as changed.
  Where nothing in scope can be compared at all, the re-capture acceptance
  criterion is ruled `not-verifiable` rather than asserting the screenshots are
  byte-identical to a run lookout never saw.

## 0.21.2

### Patch Changes

- 48a6e92: The last prose promising a dispatcher is gone. The README and the machine
  skill file stop describing `check --auto`, `backlog plan` and fix briefs,
  none of which have existed since 0.10.0; the backlog error hint stops
  advertising a `plan` subcommand that does not exist; and docstrings in
  events, status, verify-fix, the board, the ledger and rule discovery now
  describe what those files do today. The unused `EventLog.attach()`, which
  existed for the removed `lookout agent` verb, is deleted.

## 0.21.1

### Patch Changes

- 2e7de22: Issue folders now hold `Issue.json`, `Issue.md` and `img/` (previously
  `issue.json`, `ISSUE.md` and `shots/`). The folder root is unchanged:
  everything about one issue still lives in `.lookout/issues/<id>/`, and ids
  stay exactly six digits. `state.json` and `handoff.command` keep their names.

  Folders migrate themselves on the next backlog save: legacy names are removed
  before the new ones are written (the renames are case-only, so removing them
  afterwards would delete the fresh files on a case-insensitive filesystem),
  and the pixels in `shots/` are moved into `img/` rather than deleted, so they
  survive even when the evidence store they came from has been cleaned.

  The never-populated `recheck/` folder is gone from the protocol, the README
  and the UI: no code ever wrote it, and the UI strip that displayed it could
  never show anything.

  For consuming repos:

  - In `.gitignore`, change `.lookout/issues/*/shots/` to
    `.lookout/issues/*/img/` and delete the `.lookout/issues/*/recheck/` line.
    Leave `.lookout/regression/shots/` as it is; the regression store is
    unchanged.
  - A repo that committed issue folders will see every record regenerate under
    the new names. The case-only renames are invisible to git while
    `core.ignorecase` is on, so run
    `git rm -r --cached .lookout/issues && git add .lookout/issues` once to
    record them.

## 0.21.0

### Minor Changes

- ae489b2: lookout fixes the cause of its own recurring failures, in its own source, and is
  not believed about any of it.

  New user-visible capability: `lookout self-heal`. Failures now land in
  `~/.lookout/incidents.jsonl`, pooled across every project on the machine and
  never truncated: crashes and operator errors from the CLI's top-level handler,
  judge replies that could not be parsed, and findings rejected at ingestion
  because the reply broke the output contract. `events.jsonl` could never serve
  this, since every capture truncates it and the failure is gone by the time
  anybody could act on it.

  `self-heal` groups the incidents by shape, hands one group to the new
  `self-heal` skill, and gates everything that comes back. The subprocess may read
  and edit inside lookout's own checkout and may not run a single command, so
  whether the change is good is never its own report: lookout runs `tsc --noEmit`,
  `eslint`, `bun test` and the build itself, and replays a project's frozen
  regression set when `--project` names one. Any gate failing reverts the whole
  change, keeps the diff and the gate output under `~/.lookout/self-heal/<stamp>/`
  for a person to read, and records the rollback as an incident of its own. Every
  gate passing commits the change alone with a patch changeset, and does not push,
  because a local commit is one `git revert` away and a push is somebody else's
  problem to undo.

  It refuses an installed package, since there is no source to fix and no
  repository to revert in; a checkout with uncommitted work, since reverting would
  take that with it; and a second run while another holds the lock.

  `invokeClaude` gained an `allowedTools` option for this. Every judging path
  still runs read-only, which is the point: an oracle that can edit is not an
  oracle.

## 0.20.0

### Minor Changes

- 67e071e: lookout amends its own skills from what its runs got wrong, and a frozen set of
  settled verdicts decides whether the amendment survives.

  New user-visible capability: `lookout skills` (`list`, `diff`, `freeze`,
  `replay`, `improve`). `improve` reads signals lookout already records for other
  reasons, each one a case where its instructions and its judgement came apart:
  findings the adversarial verifier refuted, findings a person adjudicated
  by-design and wrote a reason for, defects that survived every attempt,
  acceptance criteria that could not be decided from a screenshot, and replies
  that failed the output contract. It writes the rules that would have prevented
  the most of them into this project's own layer, through the new
  `improve-skills` skill.

  It applies automatically. What makes that safe is that the gate is evidence
  rather than judgement: `.lookout/regression/` holds screenshots whose verdicts
  were settled when the pixels were fresh, both what a person ruled intentional
  and what the verifier confirmed. The candidate is replayed through the real
  pipeline, judge then refuter, and an amendment that re-files a suppressed
  finding or loses a confirmed one is rolled back with its violations written to
  `.lookout/skills/history.jsonl`. Matching is by category, not by attribute: the
  attribute is the judge's own wording and moves between runs on identical pixels,
  so gating on it would reject good amendments for rewording.

  An amendment nothing can grade is never applied. That covers an empty set, a
  clone whose frozen pixels are not on this machine, and skills the set cannot
  exercise; all three write `PROPOSED.md` and say why. `improve` can also propose
  a new skill, which lookout writes with the frontmatter and amendment slot it
  needs, and says plainly that nothing invokes it until a verb is wired to it.

  The manifest is committed and the frozen pixels are not, so add
  `.lookout/regression/shots/` to .gitignore; `lookout skills freeze` rebuilds
  them from the evidence store.

## 0.19.0

### Minor Changes

- 873bac2: Every issue now carries acceptance criteria, and only lookout ticks them.

  New user-visible capability: an issue states what would prove it fixed, from the
  moment it is filed. The list is on the card, in `ISSUE.md`, and in `issue.json`,
  so the agent fixing the defect reads the same criteria lookout will rule against
  rather than discovering them from a failed verification.

  Where they come from depends on who found the defect. A deterministic check
  states itself, passing, with no model involved and no cost: an axe violation
  becomes "No accessibility violation of rule `region` on / at desktop, dark
  scheme". A judged finding gets criteria from the judge, which saw the defect and
  is the only thing that can say what its absence looks like; the `visual-judge`
  skill's output contract now requires them. A finding filed before that existed
  falls back to its own `expected` prose, so no issue is left with nothing to test.
  Every issue also carries the guard the verdict rule already enforced silently:
  pixels have to have moved.

  `verify-fix` rules them, each by the thing that can actually decide it. The
  deterministic checks rule their own by re-running. The pixel hashes rule the
  re-capture guard. The judge-authored ones get an independent pass over the fresh
  screenshots through the `verify-acceptance` skill, rather than being inferred
  from whether the original finding came back: two ways of being wrong beat one
  way twice. A criterion ruled `unmet` blocks a pass. One the evidence cannot
  decide is `not-verifiable` and does not, because a criterion the pixels cannot
  settle would otherwise make an issue permanently unclosable.

  The boxes are lookout's. They render as marks rather than as
  `<input type="checkbox">`, so there is no control for a viewer to toggle and
  assistive tech reads a state rather than an editable field, and the UI server
  gained no endpoint that could change one. `lookout backlog check` now fails an
  issue with no criteria, the way it already failed a by-design finding with no
  reason.

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
