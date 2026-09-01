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
export const CORE_JUDGE = "visual-judge";

export interface PanelDef {
  /** Doubles as the skill directory name. Never contains "@": it keys the ledger. */
  name: string;
  categories: readonly Category[];
  /** Judges only view groups where a shot carries a design reference. */
  designOnly?: boolean;
}

export const PANELS: readonly PanelDef[] = [
  { name: "judge-integrity", categories: ["render-failure", "states", "anatomy"] },
  { name: "judge-geometry", categories: ["layout-overflow", "alignment", "spacing", "responsive"] },
  { name: "judge-visibility", categories: ["color-scheme", "contrast", "a11y"] },
  { name: "judge-text", categories: ["typography", "content"] },
  { name: "judge-craft", categories: ["hierarchy", "composition", "consistency"] },
  { name: "judge-design-parity", categories: ["design-parity"], designOnly: true },
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
