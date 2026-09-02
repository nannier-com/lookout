/**
 * What has been tried: every attempt lookout has ruled on, as it was reported
 * and as it was ruled, so the next attempt starts from what the last one
 * learned rather than from the screenshot alone.
 *
 * The sentences are the board's own (`src/fix/attempts.ts`); this section only
 * arranges them under the attempt they belong to and adds what the card has no
 * room for: that a judge's account repeated word for word, and what a blocked
 * issue's next ruling will count as.
 */
import { attemptSentences } from "../fix/attempts.js";
import { clusterScope, configuredRoutesOf, SHELL_MAX_ROUTES, SHELL_MIN_ROUTES } from "../fix/cluster.js";
import { DEFAULT_MAX_ATTEMPTS } from "../fix/rule.js";
import { isShellRegion } from "../backlog/lib.js";
import { panelOf } from "../judge/panels.js";
import { DEFAULT_VIEWPORTS } from "../types.js";
import { filingRunOf, type IssueContext } from "./context.js";

export function attemptsSection(ctx: IssueContext, lookoutCmd: string): string[] {
  const { cluster, state } = ctx;
  if (state.attempts.length === 0) return [];
  const l: string[] = [];
  const n = state.attempts.length;
  l.push("## What has been tried", "");
  l.push(
    `lookout has ruled on ${n} attempt${n === 1 ? "" : "s"} to fix this. Each one is recorded`,
    "as it was reported and as lookout ruled on it, so the next attempt can start",
    "from what the last one learned rather than from the screenshots alone.",
    "",
  );
  let previousNote: string | undefined;
  for (const a of state.attempts) {
    const said = attemptSentences(a);
    l.push(`### attempt ${a.n}, ${a.dispatchedAt}`, "");
    if (said.claimed) l.push(`- ${said.claimed}`);
    if (said.surfaced) l.push(`- ${said.surfaced}`);
    if (said.verdict) {
      // A judge that saw the same thing twice is the finding, and worth more
      // than the sentence again: the fix did not reach what the judge looks at.
      const same = a.judgeNote !== undefined && a.judgeNote === previousNote;
      l.push(same ? `- lookout ruled it ${a.verdict}: unchanged from attempt ${a.n - 1}` : `- ${said.verdict}`);
    }
    if (a.judgeNote !== undefined) previousNote = a.judgeNote;
    l.push("");
  }

  if (cluster.members.some((m) => m.status === "blocked")) {
    const spent = cluster.attemptsSpent;
    l.push(
      `This issue is blocked: ${spent} attempt${spent === 1 ? "" : "s"} did not clear it, and`,
      "`verify-fix` answers exit 3 for it without looking. Reopening it:",
      "",
      "```bash",
      `${lookoutCmd} backlog set --issue ${cluster.id} --status open`,
      "```",
      "",
      `The next ruling then counts as attempt ${spent + 1}. With the default cap of`,
      `${DEFAULT_MAX_ATTEMPTS} it blocks again unless it passes; \`--max-attempts ${spent + 2}\` on that`,
      "ruling leaves one more round after it.",
      "",
    );
  }
  return l;
}

/**
 * What lookout will photograph when asked to rule, and against what. A fixer
 * who patches the one route the header names and is then ruled on three is
 * failing for a reason nothing had told them; this says it first.
 */
export function scopeSection(ctx: IssueContext): string[] {
  const { cluster, resolved } = ctx;
  if (cluster.channel === "code") return [];
  const target = resolved.config.targets?.find((t) => t.name === cluster.target);
  const configured = configuredRoutesOf(resolved.config, cluster.target);
  const scope = clusterScope(cluster, configured);
  const added = scope.routes.filter((r) => !cluster.routes.includes(r));
  const shell = cluster.members.some((m) => isShellRegion(m.region));
  const l: string[] = ["## Scope of verification", ""];

  l.push(
    `\`verify-fix\` photographs target \`${cluster.target}\`${target ? ` at ${target.url}` : ""} on` +
      ` ${scope.routes.map((r) => `\`${r}\``).join(", ")}` +
      (added.length > 0
        ? `. ${added.map((r) => `\`${r}\``).join(", ")} ${added.length === 1 ? "is" : "are"} not where this was filed:` +
          ` a shell defect is ruled on at least ${SHELL_MIN_ROUTES} routes and at most ${SHELL_MAX_ROUTES},` +
          " topped up from the config in the order it lists them."
        : shell
          ? `. A shell defect is ruled on at least ${SHELL_MIN_ROUTES} routes and at most ${SHELL_MAX_ROUTES}.`
          : "."),
    "",
  );
  const formFactors = Object.keys(DEFAULT_VIEWPORTS).join(", ");
  l.push(
    `Each route is captured at ${formFactors} in dark and light, at rest and in every`,
    "navigation state lookout has planned for it, unless the flags below narrow that." +
      (cluster.channel === "ai"
        ? ` The views are re-judged by \`${panelOf(cluster.category).name}\`, the panel that filed this.`
        : " The views are re-run through lookout's own checks; no judge is involved."),
    "",
  );
  l.push(
    "lookout rules on what that URL serves at that moment. It never starts, rebuilds",
    "or restarts anything: a fix that is not built and served is not photographed." +
      (target?.startHint ? ` The config says the application is started with \`${target.startHint}\`.` : ""),
    "",
  );

  // The pixels-moved guard, and what it compares against. Stated because the
  // commonest failed attempt is one that changed nothing on screen.
  const run = filingRunOf(ctx);
  l.push(
    "Nothing passes on unchanged pixels. Every screenshot in scope is compared to",
    "lookout's previous capture of it" +
      (run ? ` (run \`${run.id}\`, finished ${run.finishedAt})` : "") +
      ", and a fix that leaves every comparable screenshot byte-identical is ruled",
    "still-open whatever the judge says. A `lookout capture` or `lookout check` of these",
    "routes between the edit and the ruling replaces that previous capture with one",
    "that already has the fix in it, and the ruling then sees no change.",
    "",
  );
  // A report written by an older lookout, or by hand, may carry a run with no
  // flags at all; the sentence is simply left out rather than the render lost.
  if (run) {
    const said = Object.entries(run.flags ?? {})
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join("/") : String(v)}`)
      .join(", ");
    if (said) l.push(`The capture that filed this ran with: ${said}.`, "");
  }

  l.push(
    "Flags `verify-fix` accepts, and what each one does to the ruling:",
    "",
    "- `--targets`, `--routes` and `--panels` are set from the issue; passing them changes nothing.",
    "- `--viewports` and `--schemes` narrow both the capture and the comparison. A criterion",
    "  about a form factor or scheme that was not captured is ruled not verifiable.",
    "- `--no-cache` re-judges views the judge ledger would otherwise answer from memory.",
    "- `--settle <ms>` waits longer before each screenshot; a different value from the",
    "  filing capture's moves pixels for reasons unrelated to the fix.",
    "- `--no-capture` rules on the last capture instead of taking a fresh one, and",
    "  `--axe off` rules every accessibility criterion met without running the check;",
    "  neither can confirm a fix.",
    "- `--headed` shows the browser; `--json` prints the ruling as JSON.",
    "",
  );
  return l;
}
