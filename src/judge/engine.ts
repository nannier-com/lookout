/**
 * The judge engine: shells out to the locally installed Claude Code CLI
 * (`claude -p`) with read-only tool access, run from a scratch directory
 * outside every project (`judgeCwd` in claude.ts) so the target repo's
 * instructions never leak into judging. Shot paths are absolute, so standing
 * nowhere near them costs the judge nothing.
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
import { scrollerLine, signalsLine } from "./signals-line.js";
import { manifestOf, preparePieces, wasRead, type Pieces } from "./manifest.js";
import { loadAriaFor } from "./aria-evidence.js";
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
  /**
   * Shots the reply called clean without the model ever opening their file
   * (or every piece of it). Already folded into `unaccounted`, so they are
   * left uncached and judged again; listed apart so the run can say why.
   */
  unread: string[];
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
  /**
   * A name a person already settled: ruled intentional, blocked, or fixed.
   *
   * It travels for its NAME, not as a defect to look for. Reusing it is what
   * lets a ruling reach a re-sighting: merge suppresses an exact fingerprint
   * and cannot suppress a synonym, so a by-design defect re-filed under a
   * fresh attribute mints a second issue the ruling never touches.
   */
  settled?: true;
}

/** One shot's accessibility tree, as the prompt builder takes it. */
export interface AriaEvidence {
  yaml: string;
  hash: string;
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
  /**
   * Each shot's accessibility tree, by shot id, for the lanes given it. Loaded
   * by judgeBatch when the lane asks and the caller has not supplied it.
   */
  aria?: ReadonlyMap<string, AriaEvidence>;
  /**
   * The pieces tall shots are read in, from `preparePieces`. Absent, every
   * shot is read whole, which is right for a prompt built for its text alone.
   */
  pieces?: Pieces;
  /**
   * The project's directory, for the incident log. Distinct from `project`,
   * which is the display name the prompt is written with: what decides where
   * a failure is recorded is a path, and a name is not one.
   */
  projectDir?: string;
}

/**
 * One shot's accessibility tree for the manifest, indented under a block
 * scalar. A tree already shown in this batch is named rather than repeated:
 * a view group is the same page at several sizes and schemes, so its members
 * usually share one tree, and printing it six times would crowd out the images.
 */
function ariaBlock(shot: ShotRecord, ctx: JudgeContext, shownBy: Map<string, string>): string {
  const tree = ctx.aria?.get(shot.id);
  if (!tree) return "";
  const already = shownBy.get(tree.hash);
  if (already) return `\n  aria: same tree as ${already}`;
  shownBy.set(tree.hash, shot.id);
  const body = tree.yaml
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
  return `\n  aria: |\n${body}`;
}

export function buildJudgePrompt(
  skillText: string,
  project: string,
  shots: ShotRecord[],
  evidenceDir: string,
  ctx: JudgeContext = {},
): string {
  const ariaShownBy = new Map<string, string>();
  // The shared description of each shot (its id, file, axes and pieces) with
  // what only the judge is told after it: the hand-off, the animation note,
  // what scrolls, and the signals.
  const manifest = manifestOf(
    shots,
    evidenceDir,
    ctx.pieces,
    (s) =>
      (s.design ? `\n  design: ${s.design}` : "") +
      (s.animated ? "\n  note: this view animates live; the still is one frame of it" : "") +
      // What scrolls in this frame, said before the signals: it changes how
      // to read everything else about the shot, because content past the
      // edge of a scroller is reachable rather than lost.
      (scrollerLine(s) ? `\n  note: something in this view ${scrollerLine(s)}` : "") +
      (signalsLine(s) ? `\n  signals: ${signalsLine(s)}` : "") +
      // Last, and only for the lanes given it: the tree is the longest thing on
      // a shot's line, so everything a judge always needs comes before it.
      ariaBlock(s, ctx, ariaShownBy),
  );

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
          "A line marked (settled) was already ruled on by a person or closed. It is",
          "here only for its name: if you see that defect, file it under exactly that",
          "category and attribute. Do not file it under a new name, and do not treat",
          "the line as a reason to file it at all.",
          ...local.map(
            (p) =>
              `- ${p.shotId}  [${p.category}/${p.attribute}]${p.settled ? " (settled)" : ""} ${p.title.slice(0, 120)}`,
          ),
          ...(cross.length > 0
            ? [
                "Also open elsewhere in this application. If the same defect is visible",
                "in these views, file it with the SAME category, attribute and region:",
                ...cross.map(
                  (p) =>
                    `- ${p.region ?? "content"}  [${p.category}/${p.attribute}]${p.settled ? " (settled)" : ""} ${p.title.slice(0, 120)}`,
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
  // Tall shots are cut into readable pieces before the prompt names them.
  const pieces = ctx.pieces ?? (await preparePieces(evidenceDir, shots));
  // The accessibility trees, for the lanes that are given them. Read here
  // rather than by every caller: what a lane is shown is a fact about the lane.
  const aria = ctx.aria ?? (ctx.panel?.aria ? await loadAriaFor(shots, evidenceDir) : undefined);
  const prompt = buildJudgePrompt(skillText, project, shots, evidenceDir, { ...ctx, pieces, ...(aria ? { aria } : {}) });
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
  // What the model opened, across both attempts: a file read before a reply
  // that failed to parse was still read.
  const reads: string[] = [];
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
        model,
        // Only when something is reading it: streaming costs the CLI an order of
        // magnitude more lines and a run nobody is watching should not pay them.
        onSay: narrating() ? (s) => say(call, voice, s) : undefined,
      });
    } finally {
      closeCall(call, voice);
    }
    text = res.text;
    reads.push(...res.reads);
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
          project: ctx.projectDir,
          judge: ctx.panel?.name,
        });
        throw new LookoutError(
          "judge reply was not parseable JSON after a retry",
          `reply head: ${text.slice(0, 200)}`,
        );
      }
    }
  }

  const ingested = ingestJudgeReply(parsed, { shots, project: ctx.projectDir, panel: ctx.panel });
  // A shot called clean that the model never opened is not clean; it is a
  // shot nobody ruled on. It joins the unaccounted, which leaves the pair out
  // of the cache and judges it again next run, and the incident names the
  // form factors, because a panel that keeps skipping the phone shots has
  // instructions that are not landing.
  const unread = ingested.cleanShotIds.filter((id) => {
    const shot = shots.find((s) => s.id === id);
    return shot !== undefined && !wasRead(shot, evidenceDir, pieces, reads);
  });
  if (unread.length > 0) {
    const where = [...new Set(unread.map((id) => shots.find((s) => s.id === id)?.formFactor ?? "?"))];
    recordIncident({
      at: new Date().toISOString(),
      kind: "judge-rejected",
      verb: "check",
      message:
        `${unread.length} shot(s) marked clean without being read (${where.join(", ")}): ` +
        unread.join(", ").slice(0, 300),
      project: ctx.projectDir,
      judge: ctx.panel?.name,
    });
  }
  return {
    ...ingested,
    cleanShotIds: ingested.cleanShotIds.filter((id) => !unread.includes(id)),
    unaccounted: [...ingested.unaccounted, ...unread],
    unread,
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
