/**
 * The judge panels: which specialist owns which categories.
 *
 * The category vocabulary is identity (every fingerprint, cluster key, and
 * regression claim carries a category), so the split into specialist judges
 * happens along it: each panel owns a disjoint subset, and together the
 * panels cover the vocabulary exactly. The partition lives here as data so
 * granularity can change without touching identity; test/judge-panels.test.ts
 * holds the covers-exactly claim, and holds each panel's skill file to the
 * same set, so the registry and the prose cannot drift apart.
 */
import { LookoutError, type ShotRecord } from "../types.js";
import type { Category } from "./rubric.js";

/** The shared-core skill every panel prompt is composed from. */
export const CORE_JUDGE = "judge-core";

export interface PanelDef {
  /** Doubles as the skill directory name. Never contains "@": it keys the ledger. */
  name: string;
  categories: readonly Category[];
  /** Judges only view groups where a shot carries a design reference. */
  designOnly?: boolean;
  /**
   * Given the shot's accessibility tree as evidence.
   *
   * Only the two panels that can act on it. The tree says what exists and what
   * a control is named, which settles an anatomy claim (is that field really
   * unlabelled) and a content claim (does that string really read `undefined`).
   * It says nothing about how anything looks, so geometry, visibility and craft
   * would pay for it in every prompt and get nothing back.
   */
  ariaEvidence?: boolean;
  /**
   * Given the project's declared design direction.
   *
   * Only the taste panel: the direction says which choices are settled and
   * which shapes the project forbids, which is the taste lane's whole question
   * and no other lane's. Filled into this panel's composed text, so it enters
   * this panel's ledger key alone: editing a DESIGN.md re-judges taste and
   * leaves every other verdict standing.
   */
  direction?: boolean;
}

export const PANELS: readonly PanelDef[] = [
  { name: "judge-integrity", categories: ["render-failure", "states", "anatomy"], ariaEvidence: true },
  { name: "judge-geometry", categories: ["layout-overflow", "alignment", "spacing", "responsive"] },
  { name: "judge-visibility", categories: ["color-scheme", "contrast", "a11y"] },
  { name: "judge-text", categories: ["typography", "content"], ariaEvidence: true },
  { name: "judge-craft", categories: ["hierarchy", "composition", "consistency"] },
  { name: "judge-design-parity", categories: ["design-parity"], designOnly: true },
  { name: "judge-taste", categories: ["taste"], direction: true },
];

/** The panel that owns a category. Total over CATEGORIES; a gap is a bug. */
export function panelOf(category: string): PanelDef {
  const panel = PANELS.find((p) => (p.categories as readonly string[]).includes(category));
  if (!panel) {
    throw new LookoutError(
      `no judge panel owns the category "${category}"`,
      "the panel registry must partition the category vocabulary",
    );
  }
  return panel;
}

/** The panels that should judge this view group. */
export function applicablePanels(group: readonly ShotRecord[]): readonly PanelDef[] {
  return PANELS.filter((p) => !p.designOnly || group.some((s) => s.design));
}

/** The adversarial verifier, the other half of every judging lesson. */
export const REFUTER = "refute-finding";

/** Whether a skill is part of the judging family the pair rule spans. */
export function isJudgeFamily(skill: string): boolean {
  return skill === CORE_JUDGE || skill === REFUTER || PANELS.some((p) => p.name === skill);
}

/**
 * The pair rule, generalized from two skills to the family.
 *
 * Any judging signal licenses the core and the refuter alongside whatever it
 * named: the lesson may be about shared judging behavior, and a filing lesson
 * sometimes belongs in the refuter's demand for evidence. What a signal never
 * licenses is a SIBLING panel: evidence about one specialist's categories says
 * nothing about another's, and the guard in amend.ts enforces exactly the set
 * returned here.
 */
export function licensedSkills(attributed: ReadonlySet<string>): Set<string> {
  const licensed = new Set(attributed);
  if ([...attributed].some(isJudgeFamily)) {
    licensed.add(CORE_JUDGE).add(REFUTER);
  }
  return licensed;
}
