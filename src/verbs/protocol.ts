/**
 * `lookout protocol`: the operating instructions, printed by lookout itself.
 *
 * lookout is driven by agents, and not only by one vendor's. Putting the
 * instructions in a Claude skill would make them invisible to every other
 * harness and would drift from the code besides. So the tool carries its own
 * contract: any agent can run `lookout protocol` and learn how to drive it,
 * and any harness integration is a one-line pointer at this verb.
 */
import { PROTOCOL } from "../fix/brief.js";
import { RULE_FILENAMES } from "../fix/rules.js";
import { printJson, type Parsed } from "../util.js";

export const WHAT_LOOKOUT_IS = [
  "lookout is a visual oracle. It captures what an application actually renders,",
  "judges the pixels against a rubric, and rules on whether a defect is gone.",
  "",
  "It never edits code and never starts services. You do both. lookout decides",
  "WHAT is wrong and WHETHER it is fixed; you decide HOW to fix it and do it.",
  "That split is the whole design: an agent that both fixes and grades its own",
  "work has no oracle, only an opinion.",
].join("\n");

export const RULES = [
  "Never claim a visual defect is fixed on your own say-so. `lookout verify-fix`",
  "  is the only thing that closes a finding.",
  "Never let the session that made a fix be the session that verifies it.",
  "Never edit anything under `.lookout/`. The backlog is lookout's to write;",
  "  adjudicate through `lookout backlog set`.",
  "Never judge without looking. Every brief names the screenshots to open, and",
  "  a contact sheet that shows them all in one image.",
  `Never edit a repository before reading its rules (${RULE_FILENAMES.slice(0, 3).join(", ")}` +
    " and the like).",
  "  Every brief lists the ones lookout found, by path.",
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
    "lookout check --auto           # judge, and emit fix work as it is found",
    "lookout agent start --cluster <id> --name \"<label>\"   # a session picked it up",
    "lookout agent done  --cluster <id> --commit <sha>      # that session replied",
    "lookout verify-fix --cluster <id> --commit <sha> --note \"<root cause>\"",
    "lookout backlog plan           # re-emit outstanding work without judging again",
    "```",
    "",
    "`check --auto` streams. It does not wait for the whole application to be",
    "judged before telling you anything: deterministic findings are dispatched",
    "before judging even starts, and each judged cluster is dispatched as soon as",
    "the routes it touches are done. Act on what it prints as it prints it.",
    "",
    "`lookout agent` is how you tell lookout what your child sessions are doing.",
    "It runs no session and rules on nothing; it only records who picked up which",
    "cluster and when, which is the difference between a live board and a list of",
    "identical rows. `lookout status` and `lookout ui` both read it.",
    "",
    "## Dispatch",
    "",
    ...PROTOCOL.map((p, i) => `${i + 1}. ${p}`),
    "",
    "## Exit codes",
    "",
    "  0  clean / the fix is confirmed",
    "  1  findings stand, or a claimed fix did not hold (a fresh brief is written)",
    "  2  lookout could not run",
    "  3  the cluster is blocked after exhausting its attempts; stop and report it",
    "",
    "## Rules",
    "",
    ...RULES.map((r) => `- ${r}`),
    "",
    "## If you are not the one fixing",
    "",
    "`lookout capture` and `lookout check` without --auto answer the simpler",
    "question: show me what this renders, and tell me what is wrong with it. Both",
    "print a contact sheet path; open it. `lookout verify --criteria <file>` rules",
    "on a ticket's acceptance criteria, and `lookout ask \"...\"` answers one",
    "question about the rendered application from fresh screenshots.",
  ].join("\n");
}

export async function protocol(parsed: Parsed): Promise<number> {
  if (parsed.flags.json) {
    printJson({ what: WHAT_LOOKOUT_IS, dispatch: PROTOCOL, rules: RULES, text: protocolText() });
  } else {
    console.log(protocolText());
  }
  return 0;
}
