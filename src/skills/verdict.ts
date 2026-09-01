/**
 * Grading a replay against the settled claims.
 *
 * regression.ts explains why the gate ignores the judge's `attribute`: it is
 * the judge's own phrasing of an aspect, it moves between runs on identical
 * pixels, and gating an amendment on it would reject good ones for rewording.
 * That argument stopped one level too early. WITHIN A PANEL'S LANE the category
 * is the same kind of thing as the attribute, because a panel owns several
 * categories and is free to file one defect under any of them.
 *
 * Measured on a 63-claim frozen set replayed with the skills completely
 * unchanged: composition 15/15 but consistency 0/6, both judge-craft;
 * layout-overflow 6/7 but responsive 1/7, both judge-geometry. Every lost
 * responsive claim sat on a shot where a layout-overflow claim was retained,
 * and every lost consistency claim sat on a shot where a composition claim was
 * retained. The panel found the defect every time. Only the label moved.
 *
 * So a mustFile claim is satisfied when ITS PANEL filed something on that shot.
 * That is not a weaker match picked for convenience: the panel is already the
 * gate's unit of causation, because replay.ts runs exactly the amended panel
 * and grades exactly its categories. Only the unit of matching lagged behind.
 * When the label does move, that is written down as drift rather than thrown
 * away, so a systematically mislabelling panel is still visible.
 *
 * mustNotFile keeps the exact category, and the asymmetry is the point. A
 * mustFile claim asks "did the panel still see the defect"; widening it forgives
 * a rewording. A mustNotFile claim asks "did the panel re-file this specific
 * suppressed thing"; widening it would call every unrelated finding the panel
 * makes on that shot a re-file, and invent violations instead of removing them.
 */
import { PANELS, panelOf } from "../judge/panels.js";
import type { AiFinding } from "../judge/engine.js";
import type { RegressionClaim, RegressionSet } from "./regression.js";

export interface Violation {
  kind: "re-filed" | "lost";
  shotId: string;
  category: string;
  /** The panel the claim belongs to: the unit a lost claim is decided at. */
  panel: string;
  why: string;
}

/** A claim its panel satisfied under a different label in the same lane. */
export interface Drift {
  shotId: string;
  panel: string;
  /** The category the claim was settled under. */
  category: string;
  /** What the panel filed on that shot instead. */
  filed: string[];
  why: string;
}

export interface ReplayVerdict {
  violations: Violation[];
  drift: Drift[];
}

const PANEL_NAMES = new Set(PANELS.map((p) => p.name));

/**
 * The panel a claim belongs to.
 *
 * Freeze records it, so the committed manifest documents the unit the gate
 * decides at rather than leaving a reader to infer it. Today's partition is the
 * fallback, which is what makes manifests frozen before the field was added
 * grade correctly, and what keeps a renamed panel from silently marking every
 * claim in its lane lost.
 */
export function claimPanel(claim: RegressionClaim): string {
  return claim.panel && PANEL_NAMES.has(claim.panel) ? claim.panel : panelOf(claim.category).name;
}

/** What each panel filed on each shot, in encounter order, deduplicated. */
function filedByLane(findings: AiFinding[]): Map<string, string[]> {
  const lanes = new Map<string, string[]>();
  for (const f of findings) {
    const key = `${f.shotId}|${panelOf(f.category).name}`;
    const cats = lanes.get(key) ?? [];
    if (!cats.includes(f.category)) cats.push(f.category);
    lanes.set(key, cats);
  }
  return lanes;
}

/**
 * Did the candidate hold? Pure: given the settled claims and what the judge said
 * this time, name every way the two disagree, and every way they only appear to.
 */
export function evaluateReplay(set: RegressionSet, findings: AiFinding[]): ReplayVerdict {
  const lanes = filedByLane(findings);
  const filedOn = new Map<string, Set<string>>();
  for (const f of findings) {
    const cats = filedOn.get(f.shotId) ?? new Set<string>();
    cats.add(f.category);
    filedOn.set(f.shotId, cats);
  }

  const violations: Violation[] = [];
  const drift: Drift[] = [];
  const seen = new Set<string>();
  const push = (v: Violation): void => {
    // Two by-design findings on one screenshot can share a category; one
    // re-filing is one violation, not two.
    const key = `${v.kind}|${v.shotId}|${v.category}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push(v);
  };

  for (const c of set.cases) {
    const filed = filedOn.get(c.shotId) ?? new Set<string>();
    for (const claim of c.mustNotFile) {
      if (!filed.has(claim.category)) continue;
      const panel = claimPanel(claim);
      push({ kind: "re-filed", shotId: c.shotId, category: claim.category, panel, why: claim.why });
    }
    for (const claim of c.mustFile) {
      const panel = claimPanel(claim);
      const lane = lanes.get(`${c.shotId}|${panel}`) ?? [];
      if (lane.length === 0) {
        push({ kind: "lost", shotId: c.shotId, category: claim.category, panel, why: claim.why });
      } else if (!lane.includes(claim.category)) {
        drift.push({ shotId: c.shotId, panel, category: claim.category, filed: lane, why: claim.why });
      }
    }
  }
  return { violations, drift };
}

/** One violation's identity, for comparing one replay's verdict with another's. */
export function violationKey(v: Violation): string {
  return `${v.kind}|${v.shotId}|${v.category}`;
}
