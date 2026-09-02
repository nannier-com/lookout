/**
 * Ingesting a judge reply: the output contract, enforced.
 *
 * The reply is model output and nothing in it is trusted. A category outside
 * the vocabulary, a severity off the ladder, or a shot id not in the batch
 * rejects the finding with an incident; a mangled region degrades to
 * "content" so the finding survives; and every shot must appear in findings
 * or cleanShotIds, because a shot in neither is one the judge did not rule
 * on. When the caller names a panel, the vocabulary narrows to that panel's
 * lane: a specialist filing a category another panel owns is a contract
 * failure even though the category exists, because the owner would file the
 * same defect and one defect must stay one finding.
 */
import type { Severity, ShotRecord } from "../types.js";
import { recordIncident } from "../skills/incidents.js";
import { problemLapses, type ProseLapse } from "../backlog/prose.js";
import { parseRegion } from "../backlog/region.js";
import { CATEGORIES, SEVERITIES, type Category } from "./rubric.js";
import { panelOf } from "./panels.js";
import { kebab } from "./grouping.js";
import type { AiFinding } from "./engine.js";

/** The lane a panel judges in: its name, and the categories it may file. */
export interface PanelLane {
  name: string;
  categories: readonly Category[];
}

/** A finding that survived ingestion with a problem written for one reader. */
export interface ContractLapse {
  shotId: string;
  category: string;
  title: string;
  judge: string;
  lapses: ProseLapse[];
}

export interface IngestedReply {
  findings: AiFinding[];
  cleanShotIds: string[];
  unaccounted: string[];
  rejected: { reason: string; raw: unknown }[];
  /**
   * Findings kept although their problem fails the two-part bar. Rejecting
   * them would throw away a real defect over its prose; counting them is
   * what lets the panel that wrote them be taught.
   */
  degraded: ContractLapse[];
}

/**
 * The other shots of this view the judge says show the SAME defect.
 *
 * Filtered to the batch, and to shots other than the one the finding was filed
 * on: a sibling naming the primary would expand into a duplicate of it, and a
 * sibling outside the batch is a shot this call never saw. An id that survives
 * neither is counted, never fatal, because the finding itself is still a real
 * defect on a real shot.
 */
function siblingIds(
  raw: Record<string, unknown>,
  primary: string,
  known: ReadonlySet<string>,
): { ids: string[]; unknown: number } {
  const listed = Array.isArray(raw.alsoShotIds) ? raw.alsoShotIds : [];
  const ids = new Set<string>();
  let bad = 0;
  for (const value of listed) {
    const id = String(value ?? "");
    if (id === primary) continue;
    if (!known.has(id)) {
      bad++;
      continue;
    }
    ids.add(id);
  }
  return { ids: [...ids], unknown: bad };
}

export function ingestJudgeReply(
  parsed: unknown,
  args: { shots: ShotRecord[]; project: string; panel?: PanelLane },
): IngestedReply {
  const { shots, project, panel } = args;
  const known = new Set(shots.map((s) => s.id));
  const findings: AiFinding[] = [];
  const rejected: { reason: string; raw: unknown }[] = [];
  // Sibling ids naming a shot outside the batch: counted per reply, because one
  // stray id is a slip and a reply full of them is a contract failure.
  let badSiblings = 0;
  // Counted rather than rejected: a region outside the closed set degrades to
  // "content" so the finding survives, but a judge that keeps mangling the
  // field is a contract failure worth one incident per batch, not silence.
  let badRegions = 0;
  const obj = parsed as { findings?: unknown; cleanShotIds?: unknown };
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  for (const f of rawFindings) {
    const r = f as Record<string, unknown>;
    const category = String(r.category ?? "");
    const severity = String(r.severity ?? "");
    const shotId = String(r.shotId ?? "");
    const region = parseRegion(r.region);
    if (region === undefined) badRegions++;
    if (!(CATEGORIES as readonly string[]).includes(category)) {
      rejected.push({ reason: `unknown category "${category}"`, raw: f });
      continue;
    }
    if (panel && !(panel.categories as readonly string[]).includes(category)) {
      rejected.push({
        reason: `category "${category}" is outside the ${panel.name} panel's lane`,
        raw: f,
      });
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
    const finding: AiFinding = {
      shotId,
      category: category as Category,
      // The category's OWNER, not the caller: before the pipeline judges one
      // panel at a time, the transitional monolith files for every lane, and
      // the ticket should already name the specialist whose rules apply.
      judge: panelOf(category).name,
      attribute: kebab(String(r.attribute ?? "general")),
      region: region ?? "content",
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
    };
    findings.push(finding);
    // One sighting per shot. The judge names the other shots of this view that
    // show the same defect and lookout expands them here, before the refuter
    // and before the accounting below: a sibling then has its own evidence to
    // be refuted on, its own fingerprint (form factor and scheme are part of
    // one), and its own row in the accounting, which is the whole point. The
    // cluster key fuses them back into one issue.
    const siblings = siblingIds(r, shotId, known);
    badSiblings += siblings.unknown;
    for (const id of siblings.ids) {
      findings.push({ ...finding, shotId: id, siblingOf: shotId });
    }
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
      judge: panel?.name,
    });
  }

  // The rubric asks for a problem in two parts, a plain sentence and then
  // the precise one. A reply that skipped the plain half still describes a
  // defect, so it is filed as written; what is recorded is that the contract
  // did not land, per finding, so the lesson reaches the right panel.
  // Primaries only: a sibling carries its primary's prose verbatim, so counting
  // both would report one badly written problem as two and teach the panel a
  // lesson twice as loud as the evidence for it.
  const degraded: ContractLapse[] = findings.filter((f) => !f.siblingOf).flatMap((f) => {
    const lapses = problemLapses(f);
    return lapses.length > 0 ? [{ shotId: f.shotId, category: f.category, title: f.title, judge: f.judge ?? panelOf(f.category).name, lapses }] : [];
  });
  if (degraded.length > 0) {
    recordIncident({
      at: new Date().toISOString(),
      kind: "judge-rejected",
      verb: "check",
      message: `${degraded.length} finding(s) filed with a problem written for one reader: ${degraded
        .map((d) => `"${d.title}" (${d.lapses.join(", ")})`)
        .join("; ")
        .slice(0, 300)}`,
      project,
      judge: panel?.name,
    });
  }

  if (badSiblings > 0) {
    recordIncident({
      at: new Date().toISOString(),
      kind: "judge-rejected",
      verb: "check",
      message: `${badSiblings} sibling shot id(s) named a shot outside this batch; the findings stand without them`,
      project,
      judge: panel?.name,
    });
  }

  if (badRegions > 0) {
    recordIncident({
      at: new Date().toISOString(),
      kind: "judge-rejected",
      verb: "check",
      message: `${badRegions} finding(s) arrived with a missing or unknown region; defaulted to content`,
      project,
      judge: panel?.name,
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
      judge: panel?.name,
    });
  }

  return { findings, cleanShotIds, unaccounted, rejected, degraded };
}
