/**
 * The end of the issue document: the commit that closed it, once one has, and
 * the one thing lookout does ask for, because it is the only thing it can
 * answer: do not take your own word for it.
 */
import { commitUrl } from "../report/forge.js";
import { DEFAULT_MAX_ATTEMPTS } from "../fix/rule.js";
import type { IssueContext } from "./context.js";

/**
 * A document for an issue nobody has fixed yet has nothing to say here and
 * says nothing; a document for a fixed one is a record, and the diff is the
 * most useful thing in it.
 */
export async function fixSection(ctx: IssueContext): Promise<string[]> {
  const fixedIn = ctx.cluster.members.find((m) => m.fixedIn?.commit)?.fixedIn?.commit;
  if (!fixedIn) return [];
  const forge = await ctx.forge();
  const url = forge ? commitUrl(forge, fixedIn) : null;
  return [
    "## The fix",
    "",
    `lookout confirmed this defect gone in \`${fixedIn}\`.`,
    ...(url ? ["", url] : ["", "The repository has no remote to read that commit on."]),
    "",
  ];
}

export function verifySection(ctx: IssueContext, lookoutCmd: string): string[] {
  const { cluster, resolved } = ctx;
  const spent = cluster.attemptsSpent > 0 ? cluster.attemptsSpent : 0;
  const cap = DEFAULT_MAX_ATTEMPTS;
  return [
    "## When you think it is fixed",
    "",
    "lookout is the only thing that can say the defect is actually gone. Ask it:",
    "",
    "```bash",
    `cd ${resolved.projectDir}`,
    `${lookoutCmd} verify-fix --issue ${cluster.id} --commit <sha> --note "<root cause>"`,
    "```",
    "",
    "`--commit` may be left out: lookout reads the repository's HEAD. `--note` is",
    "recorded with the attempt word for word, and printed above under \"What has",
    "been tried\" for whoever tries next, beside what the judge saw; the notes that",
    "have shortened a second attempt name the cause, the files changed, whether the",
    "served application was rebuilt before the ruling, and what was tried and set aside.",
    "",
    ...(cluster.channel === "code"
      ? [
          "It re-reads the source and either closes the finding or leaves it open with",
          "a note saying what the scan still sees. Nothing is re-photographed: this",
          "defect was never visible in a screenshot.",
        ]
      : [
          "It re-captures these routes, re-judges them, and either closes the finding",
          "or leaves it open with a note saying what it still sees. The section",
          "\"Scope of verification\" above says exactly what is photographed.",
        ]),
    "",
    // The cost of asking. A ruling that does not pass is not free, and an
    // agent that runs verify-fix "to see" has spent half its budget.
    `A ruling that does not pass spends an attempt: ${spent} of ${cap} ${spent === 1 ? "is" : "are"} spent,`,
    `and at ${cap} the issue is blocked and \`verify-fix\` answers exit 3 for it without`,
    "looking, until it is reopened. `--max-attempts <n>` raises the cap for one ruling.",
    "",
    "Exit 0 means confirmed, 1 means the defect is still there, 2 means lookout could",
    "not rule (the target was down, a judge or verifier failed, or a criterion went",
    "unruled) and no attempt was spent, 3 means it is out of attempts.",
    "",
  ];
}
