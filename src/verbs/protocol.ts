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

export const RULES = [
  "Never claim a visual defect is fixed on your own say-so. `lookout verify-fix`",
  "  is the only thing that closes a finding.",
  "Never let the session that made a change be the session that rules on it.",
  "Never edit anything under `.lookout/`. The backlog and the issue folders",
  "  are lookout's to write;",
  "  adjudicate through `lookout backlog set`.",
  "Never judge without looking. Every issue names the screenshots it was filed",
  "  against, and a contact sheet that shows them all in one image.",
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
    "  issue.json      the record",
    "  ISSUE.md        what is wrong, where, and what lookout has ruled",
    "  shots/          the screenshots it was filed against",
    "  recheck/        what the last verify-fix saw afterwards",
    "  state.json      every attempt, and how each one was ruled",
    "```",
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
