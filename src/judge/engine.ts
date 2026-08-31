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
import { CATEGORIES, SEVERITIES, type Category } from "./rubric.js";

import { extractJson, invokeClaude } from "./claude.js";
import { kebab } from "./grouping.js";

export interface AiFinding {
  shotId: string;
  category: Category;
  attribute: string;
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
  raw: string;
  costUsd?: number;
  durationMs: number;
}

export interface PriorFinding {
  shotId: string;
  category: string;
  attribute: string;
  title: string;
}

export interface JudgeContext {
  /** Hand-off instructions, carried only when a shot has a `design:` reference. */
  handoff?: string;
  /** What lookout already has open on these views, so a re-file keeps its name. */
  prior?: PriorFinding[];
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
  const prior = (ctx.prior ?? []).filter((p) => known.has(p.shotId));
  const priorFindings =
    prior.length === 0
      ? ""
      : [
          "=== ALREADY FILED ON THESE VIEWS ===",
          "Defects lookout already has open here. If you still see one, file it with",
          "the SAME category and attribute so it is recognised as the same defect and",
          "not a new one. If it is gone, just leave it out; absence is how a fix is",
          "reported. This list is not a claim that these are still there.",
          ...prior.map(
            (p) => `- ${p.shotId}  [${p.category}/${p.attribute}] ${p.title.slice(0, 120)}`,
          ),
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

  let text = "";
  let costUsd: number | undefined;
  let parsed: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await invokeClaude({
      prompt: attempt === 0 ? prompt : prompt + RETRY_SUFFIX,
      cwd: evidenceDir,
      model,
    });
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
        });
        throw new LookoutError(
          "judge reply was not parseable JSON after a retry",
          `reply head: ${text.slice(0, 200)}`,
        );
      }
    }
  }

  const known = new Set(shots.map((s) => s.id));
  const findings: AiFinding[] = [];
  const rejected: { reason: string; raw: unknown }[] = [];
  const obj = parsed as { findings?: unknown; cleanShotIds?: unknown };
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  for (const f of rawFindings) {
    const r = f as Record<string, unknown>;
    const category = String(r.category ?? "");
    const severity = String(r.severity ?? "");
    const shotId = String(r.shotId ?? "");
    if (!(CATEGORIES as readonly string[]).includes(category)) {
      rejected.push({ reason: `unknown category "${category}"`, raw: f });
      continue;
    }
    if (!(SEVERITIES as readonly string[]).includes(severity)) {
      rejected.push({ reason: `unknown severity "${severity}"`, raw: f });
      continue;
    }
    if (!known.has(shotId)) {
      rejected.push({ reason: `unknown shotId "${shotId}"`, raw: f });
      continue;
    }
    findings.push({
      shotId,
      category: category as Category,
      attribute: kebab(String(r.attribute ?? "general")),
      severity: severity as Severity,
      title: String(r.title ?? "").slice(0, 200),
      problem: String(r.problem ?? "").slice(0, 1500),
      expected: String(r.expected ?? "").slice(0, 800),
      observed: String(r.observed ?? "").slice(0, 800),
      confidence: (["high", "medium", "low"] as const).includes(
        r.confidence as "high" | "medium" | "low",
      )
        ? (r.confidence as "high" | "medium" | "low")
        : "medium",
      // Capped and trimmed: this is a checklist somebody reads, and a judge
      // that returns a paragraph per entry has written prose, not a criterion.
      acceptance: (Array.isArray(r.acceptance) ? r.acceptance : [])
        .filter((a): a is string => typeof a === "string" && a.trim().length > 0)
        .slice(0, 6)
        .map((a) => a.trim().slice(0, 300)),
    });
  }
  const cleanShotIds = (Array.isArray(obj.cleanShotIds) ? obj.cleanShotIds : [])
    .map(String)
    .filter((id) => known.has(id));

  // The contract's own check: every shot was to appear in one list or the other.
  // A shot in neither is one the judge did not rule on, and treating that as
  // clean is the false negative this whole pipeline exists to avoid.
  const accountedFor = new Set([...findings.map((f) => f.shotId), ...cleanShotIds]);
  const unaccounted = shots.map((s) => s.id).filter((id) => !accountedFor.has(id));
  if (unaccounted.length > 0) {
    recordIncident({
      at: new Date().toISOString(),
      kind: "judge-rejected",
      verb: "check",
      message:
        `${unaccounted.length} shot(s) appeared in neither findings nor cleanShotIds: ` +
        unaccounted.join(", ").slice(0, 300),
      project,
    });
  }

  // A rejected finding is work the judge did and lookout threw away, because
  // the reply did not honour the contract it was given. That is a failure of
  // the instructions, and it is only visible if it is written down.
  if (rejected.length > 0) {
    recordIncident({
      at: new Date().toISOString(),
      kind: "judge-rejected",
      verb: "check",
      message: `${rejected.length} finding(s) rejected at ingestion: ${rejected
        .map((r) => r.reason)
        .join("; ")
        .slice(0, 300)}`,
      project,
    });
  }

  return {
    findings,
    cleanShotIds,
    unaccounted,
    rejected,
    raw: text,
    costUsd,
    durationMs: Date.now() - started,
  };
}

// The subprocess contract and the grouping rules live beside this file; they
// are re-exported because this is the module every caller has always asked for
// them from.
export { claudeBin, extractJson, invokeClaude, type JudgeInvocation } from "./claude.js";
export { batchShots, groupShots, viewGroupId } from "./grouping.js";
