/**
 * The judge engine: shells out to the locally installed Claude Code CLI
 * (`claude -p`) with read-only tool access, cwd-pinned to the evidence
 * directory so the target repo's instructions never leak into judging.
 *
 * The subprocess reads the screenshot files itself (vision via the Read
 * tool); lookout passes paths plus a manifest and demands a strict JSON
 * reply, retrying once with a harder instruction when parsing fails.
 */
import { LookoutError, type Severity, type ShotRecord } from "../types.js";
import { renderSkill } from "../skills/load.js";
import { recordIncident } from "../skills/incidents.js";
import type { Region } from "../backlog/region.js";
import type { Category } from "./rubric.js";

import { extractJson, invokeClaude } from "./claude.js";
import { closeCall, narrating, openCall, say } from "../report/narration.js";
import { ingestJudgeReply, type ContractLapse, type PanelLane } from "./reply.js";

export interface AiFinding {
  shotId: string;
  category: Category;
  /**
   * The panel that owns the finding's category, stamped at ingestion so a
   * ticket can say which specialist filed it and an amendment can target that
   * specialist's skill. Optional because verdicts cached before the stamp
   * existed come back without it; readers fall back to deriving it from the
   * category.
   */
  judge?: string;
  attribute: string;
  /**
   * The shot this finding was copied from, when the judge listed this one in
   * that finding's `alsoShotIds`.
   *
   * A defect visible on four shots of a view is one defect and four sightings.
   * The judge files it once and names the rest; ingestion expands each named
   * shot into its own finding so the shot is accounted for, the refuter can
   * kill an over-listed sibling on its own evidence, and the fingerprint (which
   * carries form factor and scheme) stays the identity it has always been.
   * Present only on the copies, never on the shot the judge chose.
   */
  siblingOf?: string;
  /**
   * Which part of the frame the defect lives in. Never trusted blindly: an
   * unknown or missing value degrades to "content", the route-scoped default,
   * because a mangled region must cost precision, not the finding.
   */
  region: Region;
  severity: Severity;
  title: string;
  problem: string;
  expected: string;
  observed: string;
  confidence: "high" | "medium" | "low";
  /** What would prove this defect gone, in the judge's own words. */
  acceptance: string[];
}

export interface JudgeBatchResult {
  findings: AiFinding[];
  cleanShotIds: string[];
  /**
   * Shots the reply accounted for in neither `findings` nor `cleanShotIds`.
   *
   * The output contract requires every shot to appear in one of them, precisely
   * so a judge that quietly skipped one can be detected. Nothing read this, so a
   * skipped shot was indistinguishable from a clean one and was cached as clean,
   * durably. These are the shots lookout has no verdict for, and saying so is
   * the difference between "clean" and "not looked at".
   */
  unaccounted: string[];
  rejected: { reason: string; raw: unknown }[];
  /** Findings filed although their problem is written for one reader. */
  degraded: ContractLapse[];
  raw: string;
  costUsd?: number;
  durationMs: number;
}

export interface PriorFinding {
  /**
   * The shot the defect is open on, or "*" for one that is open everywhere:
   * a shell finding belongs to the application's frame rather than to any
   * view, so its name has to travel to every batch or each route's call would
   * re-mint it under a fresh attribute and split the issue.
   */
  shotId: string;
  category: string;
  attribute: string;
  title: string;
  region?: Region;
}

export interface JudgeContext {
  /** Hand-off instructions, carried only when a shot has a `design:` reference. */
  handoff?: string;
  /** What lookout already has open on these views, so a re-file keeps its name. */
  prior?: PriorFinding[];
  /**
   * The lane this call judges in. Absent, the full vocabulary applies, which
   * is what the transitional monolith and the regression replay want.
   */
  panel?: PanelLane;
}

/** At most this many deterministic signals per shot: corroboration, not a list. */
const MAX_SIGNALS = 3;

/**
 * The deterministic checks' findings for one shot, compactly.
 *
 * These are already computed and attached to every shot, and the judge never
 * saw them. They are the one thing in this pipeline that IS a measurement: axe
 * knows the rule that fired, the overflow check knows the selector and the
 * amount. Giving them to a model that cannot measure is free precision, and it
 * localizes: "something overflows here" plus a selector beats hunting the image.
 */
function signalsOf(shot: ShotRecord): string {
  const parts = shot.deterministicFindings
    .filter((f) => f.severity !== "info")
    .slice(0, MAX_SIGNALS)
    .map((f) => `${f.type}: ${f.message.slice(0, 120)}`);
  return parts.length > 0 ? `\n  signals: ${parts.join(" | ")}` : "";
}

export function buildJudgePrompt(
  skillText: string,
  project: string,
  shots: ShotRecord[],
  evidenceDir: string,
  ctx: JudgeContext = {},
): string {
  const manifest = shots
    .map(
      (s) =>
        `- shotId: ${s.id}\n  file: ${evidenceDir}/${s.path}\n  route: ${s.route} (${s.routeName})  state: ${s.state}  formFactor: ${s.formFactor}  scheme: ${s.scheme}  size: ${s.width}x${s.height}` +
        (s.design ? `\n  design: ${s.design}` : "") +
        (s.animated ? "\n  note: this view animates live; the still is one frame of it" : "") +
        signalsOf(s),
    )
    .join("\n");

  // Instructions for comparing against a design hand-off are a quarter of the
  // rubric and mean nothing without one, so a batch with no `design:` reference
  // does not carry them. Always FILLED, though: renderSkill refuses a prompt
  // with a placeholder left in it, which is what keeps that guarantee honest.
  const handoff = shots.some((s) => s.design) ? ctx.handoff ?? "" : "";

  // What is already open on these views. The attribute is free text the judge
  // writes, and it is half of both the fingerprint and the cluster key, so the
  // same defect coming back as "dark-theme-stuck" instead of
  // "theme-not-switching" mints a second issue, splits the attempt history, and
  // makes the first one look drift-resolved. Showing the judge the name a defect
  // already has costs a few lines and keeps one defect one issue.
  const known = new Set(shots.map((s) => s.id));
  const local = (ctx.prior ?? []).filter((p) => known.has(p.shotId));
  // Shell defects are open everywhere at once, so their names reach every
  // batch. Without this, a route that also shows the defect re-mints it under
  // a fresh attribute, and the one-identity collapse never fuses.
  const cross = (ctx.prior ?? []).filter((p) => p.shotId === "*");
  const priorFindings =
    local.length === 0 && cross.length === 0
      ? ""
      : [
          "=== ALREADY FILED ON THESE VIEWS ===",
          "Defects lookout already has open here. If you still see one, file it with",
          "the SAME category and attribute so it is recognised as the same defect and",
          "not a new one. If it is gone, just leave it out; absence is how a fix is",
          "reported. This list is not a claim that these are still there.",
          ...local.map(
            (p) => `- ${p.shotId}  [${p.category}/${p.attribute}] ${p.title.slice(0, 120)}`,
          ),
          ...(cross.length > 0
            ? [
                "Also open elsewhere in this application. If the same defect is visible",
                "in these views, file it with the SAME category, attribute and region:",
                ...cross.map(
                  (p) =>
                    `- ${p.region ?? "content"}  [${p.category}/${p.attribute}] ${p.title.slice(0, 120)}`,
                ),
              ]
            : []),
          "=== END ALREADY FILED ===",
        ].join("\n");

  return renderSkill(skillText, {
    project,
    shotCount: shots.length,
    manifest,
    handoff,
    priorFindings,
  });
}

export const RETRY_SUFFIX =
  "\n\nYour previous reply could not be parsed. Reply with NOTHING but the fenced ```json block.";

export async function judgeBatch(
  skillText: string,
  project: string,
  shots: ShotRecord[],
  evidenceDir: string,
  model: string,
  ctx: JudgeContext = {},
): Promise<JudgeBatchResult> {
  const started = Date.now();
  const prompt = buildJudgePrompt(skillText, project, shots, evidenceDir, ctx);
  // Who is speaking, for anything reading the run as it happens. The lane's
  // name where there is one, because that is what the page counts progress in.
  const voice = ctx.panel?.name ?? "judge";
  // And which view it is speaking about. Two workers judge two groups at once
  // and reach the same panel at the same time, so the name alone would put two
  // different verdicts under one indistinguishable heading.
  const about = shots[0] ? `${shots[0].target}${shots[0].route}` : "the evidence";

  let text = "";
  let costUsd: number | undefined;
  let parsed: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const call = openCall(
      voice,
      attempt === 0 ? `${about} · ${shots.length} shot(s)` : `${about} · asked again for JSON`,
    );
    // In a finally, because a panel that throws is exactly the panel whose call
    // must be seen to end: an unclosed call leaves the page pulsing at a judge
    // that stopped, for as long as the tab is open.
    let res: Awaited<ReturnType<typeof invokeClaude>>;
    try {
      res = await invokeClaude({
        prompt: attempt === 0 ? prompt : prompt + RETRY_SUFFIX,
        cwd: evidenceDir,
        model,
        // Only when something is reading it: streaming costs the CLI an order of
        // magnitude more lines and a run nobody is watching should not pay them.
        onSay: narrating() ? (s) => say(call, voice, s) : undefined,
      });
    } finally {
      closeCall(call, voice);
    }
    text = res.text;
    costUsd = (costUsd ?? 0) + (res.costUsd ?? 0);
    try {
      parsed = extractJson(text);
      break;
    } catch {
      if (attempt === 1) {
        recordIncident({
          at: new Date().toISOString(),
          kind: "judge-unparseable",
          verb: "check",
          message: "judge reply was not parseable JSON after a retry",
          detail: text.slice(0, 1000),
          project,
          judge: ctx.panel?.name,
        });
        throw new LookoutError(
          "judge reply was not parseable JSON after a retry",
          `reply head: ${text.slice(0, 200)}`,
        );
      }
    }
  }

  const ingested = ingestJudgeReply(parsed, { shots, project, panel: ctx.panel });
  return {
    ...ingested,
    raw: text,
    costUsd,
    durationMs: Date.now() - started,
  };
}

// The subprocess contract and the grouping rules live beside this file; they
// are re-exported because this is the module every caller has always asked for
// them from.
export { claudeBin, extractJson, invokeClaude, type JudgeInvocation } from "./claude.js";
export { type JudgeSay } from "./stream.js";
export { batchShots, groupShots, viewGroupId } from "./grouping.js";
export { ingestJudgeReply, type ContractLapse, type PanelLane } from "./reply.js";
