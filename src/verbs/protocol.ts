/**
 * `lookout protocol`: the operating instructions, printed by lookout itself.
 *
 * lookout is driven by agents, and not only by one vendor's. Putting the
 * instructions in a Claude skill would make them invisible to every other
 * harness and would drift from the code besides. So the tool carries its own
 * contract: any agent can run `lookout protocol` and learn how to drive it,
 * and any harness integration is a one-line pointer at this verb.
 */
import { printJson, type Parsed } from "../util.js";

export const WHAT_LOOKOUT_IS = [
  "lookout is a visual oracle. It captures what an application actually renders,",
  "judges the pixels against a rubric, writes down what is wrong, and rules on",
  "whether a defect is gone when you ask it to.",
  "",
  "It finds issues and documents them. It does not fix them, it does not decide",
  "who fixes them, and it never starts work of its own: no sessions, no agents,",
  "no dispatch. What to do about a finding is your call, not lookout's.",
  "",
  "That split is the whole design. An agent that both fixes and grades its own",
  "work has no oracle, only an opinion, so lookout stays on one side of it: it",
  "says WHAT is wrong and, when asked, WHETHER it is still wrong.",
].join("\n");

/**
 * One rule per entry. They used to be one PHYSICAL LINE per entry, which the
 * renderer then bulleted individually, so every wrapped rule came out as two
 * bullets saying half a thing each.
 */
export const RULES = [
  "Never claim a visual defect is fixed on your own say-so. `lookout verify-fix`\n" +
    "  is the only thing that closes a finding.",
  "Never let the session that made a change be the session that rules on it.",
  "Never edit anything under `.lookout/`. The backlog and the issue folders are\n" +
    "  lookout's to write; adjudicate through `lookout backlog set`.",
  "Never judge without looking. Every issue names the screenshots it was filed\n" +
    "  against, and keeps a copy of them in its own folder.",
  "In a project with a design system, fix the defect where the issue says it\n" +
    "  belongs, not where you photographed it. A component's defect is fixed in the\n" +
    "  component, once, for every caller. If the kit is missing what you need, add\n" +
    "  it to the kit backwards-compatibly rather than hand-rolling it in the app.",
  "Localhost only, unless the user explicitly passes --allow-remote.",
];

export function protocolText(): string {
  return [
    "# lookout operating protocol",
    "",
    WHAT_LOOKOUT_IS,
    "",
    "## The loop",
    "",
    "```bash",
    "lookout doctor                 # prerequisites, once per machine",
    "lookout targets                # what this project declares, and whether it is up",
    "lookout design-system          # what it is built from, and where a fix belongs",
    "lookout check                  # capture, judge, and write findings to the backlog",
    "lookout ui                     # read the findings, with their screenshots",
    "lookout verify-fix --issue <id> --commit <sha> --note \"<root cause>\"",
    "```",
    "",
    "`check` narrates to disk as it goes, so `lookout status` and `lookout ui`",
    "both show findings while the run is still going rather than after it exits.",
    "",
    "## What you get",
    "",
    "Findings are grouped into issues: one issue is one target, category and",
    "attribute, which is as close as lookout can get to one root cause. Each",
    "gets a six-digit id the first time it is seen, and keeps it for good.",
    "",
    "Everything about one issue lives in one folder, named by that id:",
    "",
    "```",
    ".lookout/issues/418203/",
    "  Issue.json      the record",
    "  Issue.md        what is wrong, where, and what lookout has ruled",
    "  img/pre/        the defect, frozen when the issue was filed",
    "  img/post/       the same views once lookout ruled a fix on them",
    "  state.json      every attempt, and how each one was ruled",
    "```",
    "",
    "Every issue also carries acceptance criteria: what would prove it fixed,",
    "written to be decidable from a screenshot of the same view. They are in",
    "the document you are handed, so you know what you will be graded against.",
    "Only lookout ticks them, and only `verify-fix` does it.",
    "",
    "The backlog under `.lookout/` is the durable record and the issue folders",
    "are written from it. `lookout ui` is built from the backlog rather than",
    "from any single run's narration.",
    "",
    "## When something has been fixed",
    "",
    "Ask lookout to rule on it: `lookout verify-fix --issue <id> --commit <sha>",
    "--note \"<root cause>\"`. It re-captures the routes in scope, re-judges them,",
    "and either closes the finding or leaves it open with a note saying what it",
    "still sees. Nothing else closes a finding.",
    "",
    "It rules on that issue and nothing else. If the fix cleared the defect and",
    "caused a different one, the issue passes and the new defect is filed as its",
    "own issue, with its own number and a note saying which fix surfaced it. So",
    "a pass can come with new work: the ruling names any issues the run filed,",
    "and `spawned` carries them under --json.",
    "",
    "## Exit codes",
    "",
    "  0  clean / the fix is confirmed",
    "  1  findings stand, or a claimed fix did not hold",
    "  2  lookout could not run",
    "  3  the defect survived its attempts; it needs a person",
    "",
    "## Rules",
    "",
    ...RULES.map((r) => `- ${r}`),
    "",
    "## The other verbs",
    "",
    "`lookout skills` is how lookout learns. Everything it knows how to judge is",
    "a skill file, this project can amend any of them, and `lookout skills",
    "improve` writes those amendments from what its own runs got wrong. An",
    "amendment applies only if a frozen set of already-adjudicated screenshots",
    "still holds; one that re-files something ruled intentional, or loses a",
    "confirmed defect, is rolled back. `check` and `verify-fix` run improve",
    "automatically once enough NEW evidence accumulates (a by-design",
    "adjudication fires alone); decline it with --no-improve for a run,",
    "`learn: { auto: false }` in the config for good. CI never auto-learns.",
    "",
    "`lookout self-heal` turns the same machinery on lookout: it reads the",
    "incidents lookout has hit across every project, fixes the cause of one in",
    "its own source, and reverts the lot unless the type check, the linter, the",
    "tests, the build and the frozen set all pass afterwards.",
    "",
    "## Design systems",
    "",
    "Most applications are built out of a component kit, and a defect found on a",
    "screen is usually fixed in a component: a different file, often in a",
    "different package. Fix it on the screen instead and the kit stays broken for",
    "every other consumer, the screen acquires an override that will drift, and",
    "the next person to touch the component has no idea why it is special.",
    "",
    "So lookout reads the repository and works out what it is built from, and",
    "every issue document carries a `Where this belongs` section naming the file",
    "to change, why there and not the other place, and how many other callers a",
    "change would reach. `lookout design-system` prints the same inventory on its",
    "own. When the kit is an installed dependency rather than this repository's",
    "source, the issue says so: the fix is to the application's use of it, never",
    "a patch inside node_modules.",
    "",
    "It also files what it can see without a screenshot. A control an application",
    "hand-rolls out of raw elements, where the kit already provides it, is a real",
    "defect that no photograph can show, so it is filed on its own channel and",
    "ruled by re-reading the source rather than by re-capturing anything.",
    "",
    "Two things find those. A scan matches names and only looks at files that",
    "import the kit nowhere. A reading pass then goes through the application",
    "with the kit's actual export list in hand, which is what catches a screen",
    "that imports the kit for its text and builds a button out of a styled div",
    "beside it, and what kills the suspicions the scan got wrong. It runs as part",
    "of `check` (`--no-conformance` turns it off, `--max-conformance N` caps the",
    "files), and `lookout design-system --audit` runs it on its own without",
    "filing anything. Unchanged files cost nothing on a second run.",
    "",
    "A hand-rolled control the kit has no equivalent for is still filed, and it",
    "says so: the work there is to add the thing to the kit and consume it, not",
    "to swap an import for a component that does not exist.",
    "",
    "Ruling on a fix keeps what it ruled on. The evidence store writes each view",
    "back to the path it came from, so the re-capture that clears an issue",
    "overwrites the picture of the defect; `verify-fix` copies that frame aside",
    "first, and copies the cleared one aside when it passes, so an issue carries",
    "both sides of its own fix. It also carries the commit it landed in, linked",
    "to whichever forge the repository lives on.",
    "",
    "A confirmed fix is not work any more. `lookout ui` offers to archive one,",
    "which moves its folder to `.lookout/issues/archive/<id>` and takes it off",
    "the board. It refuses while anything is still open, and an archived issue",
    "whose defect comes back un-archives itself on the save that reopens it.",
    "",
    "`lookout capture` answers the simpler question: show me what this renders.",
    "`lookout verify --criteria <file>` rules on a ticket's acceptance criteria,",
    "and `lookout ask \"...\"` answers one question about the rendered application",
    "from fresh screenshots.",
  ].join("\n");
}

export async function protocol(parsed: Parsed): Promise<number> {
  if (parsed.flags.json) {
    printJson({ what: WHAT_LOOKOUT_IS, rules: RULES, text: protocolText() });
  } else {
    console.log(protocolText());
  }
  return 0;
}
