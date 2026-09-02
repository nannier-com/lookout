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
import { existsSync } from "node:fs";
import { attemptSentences } from "../fix/attempts.js";
import { SHELL_MAX_ROUTES, SHELL_MIN_ROUTES } from "../fix/cluster.js";
import { DEFAULT_MAX_ATTEMPTS } from "../fix/rule.js";
import { artifactsOf, scopeOf } from "./facts.js";
import type { AttemptRecord } from "../fix/state.js";
import { baselineSaid } from "../verify/outcome-report.js";
import { filingRunOf, type IssueContext } from "./context.js";

/**
 * What lookout observed in the repository when it ruled, said apart from what
 * the fixer reported: whether anything was committed, and whether the change
 * landed in the files the fix was meant to touch.
 */
function observationLines(a: AttemptRecord): string[] {
  const o = a.observed;
  if (!o) return [];
  const parts: string[] = [];
  if (o.head) parts.push(`HEAD ${o.head}`);
  if (o.dirty === true) {
    parts.push(
      `${o.dirtyFiles?.length ?? 0} uncommitted file(s)` + (o.dirtyFiles?.length ? `: ${o.dirtyFiles.join(", ")}` : ""),
    );
  } else if (o.dirty === false) {
    parts.push("working tree clean");
  }
  if (o.filesChanged) {
    parts.push(
      o.filesChanged.length === 0
        ? `no files changed since attempt ${a.n - 1}`
        : `changed since attempt ${a.n - 1}: ${o.filesChanged.join(", ")}`,
    );
  }
  return parts.length > 0 ? [`- in the repository: ${parts.join("; ")}`] : [];
}

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
    l.push(...observationLines(a));
    if (a.totalShots !== undefined) {
      l.push(
        `- re-captured: ${a.changedShots ?? 0} of ${a.baselineShots ?? 0} comparable screenshot(s) changed` +
          ` (${a.totalShots} in scope)` +
          (a.runId ? `, run ${a.runId}` : "") +
          (a.baseline ? `, compared against ${baselineSaid(a.baseline)}` : "") +
          (a.flags ? `; flags: ${Object.entries(a.flags).map(([k, v]) => (v === true ? `--${k}` : `--${k} ${v}`)).join(" ")}` : ""),
      );
    } else if (a.runId) {
      l.push(`- run ${a.runId}`);
    }
    if (a.unclosable && a.unclosable.length > 0) {
      l.push(`- pixels unchanged since filing on ${a.unclosable.join(", ")}, so nothing there could close`);
    }
    for (const f of a.stillOpen ?? []) {
      l.push(`- still filed after this attempt: ${f.title}${f.shotId ? ` (${f.shotId})` : ""}: ${f.observed}`);
    }
    for (const c of (a.criteria ?? []).filter((c) => c.verdict === "unmet")) {
      l.push(`- criterion not met: ${c.text}${c.note ? `: ${c.note}` : ""}`);
    }
    if (said.surfaced) l.push(`- ${said.surfaced}`);
    if (said.verdict) {
      // A judge that saw the same thing twice is the finding, and worth more
      // than the sentence again: the fix did not reach what the judge looks at.
      const same = a.judgeNote !== undefined && a.judgeNote === previousNote;
      l.push(same ? `- lookout ruled it ${a.verdict}: unchanged from attempt ${a.n - 1}` : `- ${said.verdict}`);
    }
    if (a.contactSheet && existsSync(a.contactSheet)) l.push(`- contact sheet of that capture: ${a.contactSheet}`);
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
  const { cluster } = ctx;
  const scope = scopeOf(ctx);
  if (!scope) return [];
  const { added, shell } = scope;
  const l: string[] = ["## Scope of verification", ""];

  l.push(
    `\`verify-fix\` photographs target \`${cluster.target}\`${scope.url ? ` at ${scope.url}` : ""} on` +
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
  l.push(
    scope.platform === "web"
      ? `Each route is captured at ${scope.formFactors.join(", ")} in ${scope.schemes.join(" and ")}, at rest and in every`
      : `Each route is captured on ${scope.platform} (${scope.formFactors.join(", ")}) in ${scope.schemes.join(" and ")}, at rest and in every`,
    "navigation state lookout has planned for it, unless the flags below narrow that." +
      (scope.panel
        ? ` The views are re-judged by \`${scope.panel}\`, the panel that filed this.`
        : " The views are re-run through lookout's own checks; no judge is involved."),
    "",
  );
  l.push(
    "lookout rules on what that URL serves at that moment. It never starts, rebuilds",
    "or restarts anything: a fix that is not built and served is not photographed." +
      (scope.startHint ? ` The config says the application is started with \`${scope.startHint}\`.` : ""),
    "",
  );

  // The pixels-moved guard, and what it compares against. Stated because the
  // commonest failed attempt is one that changed nothing on screen.
  const run = filingRunOf(ctx);
  const against = ctx.state.baseline
    ? `the capture of the previous ruling (run \`${ctx.state.baseline.runId}\`, ${ctx.state.baseline.capturedAt})`
    : ctx.frames.before.length > 0
      ? `the frames frozen when this issue was filed (${ctx.frames.before[0]!.at})`
      : `lookout's last capture of these routes${run ? ` (run \`${run.id}\`, finished ${run.finishedAt})` : ""}`;
  l.push(
    "Nothing passes on unchanged pixels. Every screenshot in scope is compared to",
    `${against}, and a fix that leaves every comparable screenshot byte-identical is`,
    "ruled still-open whatever the judge says. A `lookout capture` or `lookout check`",
    "between the edit and the ruling does not move that baseline: the ruling is always",
    "measured against the previous ruling's capture, or the defect as filed.",
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

/**
 * Where everything lookout wrote about this lives, absolute. The config is
 * always named; the rest only when it is on disk, because the capture
 * workspace is rebuilt by every capture and a path to a file that is gone is
 * a wrong answer, not a pointer.
 */
export function artifactsSection(ctx: IssueContext): string[] {
  const l: string[] = ["## Artifacts", ""];
  l.push(
    "Where everything lookout wrote about this lives. The files under the project's",
    "`.lookout/` are durable; the capture workspace is rebuilt by every capture.",
    "",
  );
  for (const a of artifactsOf(ctx)) {
    if (a.name === "config" || a.exists) l.push(`- ${a.name}: ${a.path}`);
  }
  l.push("");
  return l;
}
