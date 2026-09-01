/**
 * Asking where a defect belongs.
 *
 * This is the one place lookout lets a model read the target repository, and
 * the boundary it crosses is deliberate enough to be worth stating.
 *
 * The visual judge is cwd-pinned to the evidence directory with Read alone, so
 * the repository's own instructions can never reach the thing deciding whether
 * a defect exists. That protection matters and it stays exactly as it is. This
 * pass is a different question: not "is this wrong" but "where does the fix
 * go", which cannot be answered without reading the code, and which is
 * downstream of a verdict already reached. So the worst a misleading repository
 * can do here is send a fix to the wrong file, which the person doing the
 * fixing will notice. It cannot suppress a finding, soften a severity, or close
 * an issue: none of those are this pass's to touch.
 *
 * Read-only, always: Read, Grep and Glob, no Edit, no Write, no Bash. lookout
 * is an oracle, and an oracle that edits the code it advises on is just another
 * agent with an opinion.
 */
import { invokeClaude, extractJson } from "../judge/engine.js";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadSkill, renderSkill } from "../skills/load.js";
import { evidenceDir } from "../config.js";
import { provenanceBrief } from "./provenance-brief.js";
import type { DesignInventory } from "./inventory.js";
import type { FixCluster } from "../fix/cluster.js";
import type { ResolvedConfig } from "../types.js";

export type PlacementKind =
  | "kit-component"
  | "app-composition"
  | "tokens"
  | "kit-gap"
  | "unclear";

export interface Placement {
  placement: PlacementKind;
  primaryPath: string | null;
  symbol: string | null;
  reason: string;
  otherCallers: number | null;
  blastRadius: string;
  alsoRead: string[];
  notes: string;
}

/** The inventory as the skill sees it: facts, in the order they matter. */
export function inventoryBrief(inv: DesignInventory): string {
  const l: string[] = [];
  for (const [i, k] of inv.kits.entries()) {
    l.push(`${i === 0 ? "PRIMARY KIT" : "also present"}: ${k.name}`);
    l.push(`  found by: ${k.via} (${k.evidence[0] ?? "-"})`);
    l.push(
      k.editable
        ? "  this kit's source IS in this repository and can be changed here"
        : "  this kit is an installed dependency: its source is NOT this repository's to edit",
    );
    if (k.packageRoot) l.push(`  package root: ${k.packageRoot}`);
    for (const c of k.componentRoots) l.push(`  components: ${c}`);
    if (k.importPrefixes.length) l.push(`  imported as: ${k.importPrefixes.join(", ")}`);
    // What the kit actually ships, read from the kit. Without it a model asked
    // where a fix belongs has to guess whether the component it wants exists.
    if (k.exports.length > 0) {
      l.push(`  provides: ${k.exports.slice(0, 80).join(", ")}${k.exports.length > 80 ? ", ..." : ""}`);
    } else {
      l.push("  provides: could not be read from here; do not assume what it exports");
    }
    if (k.docs) l.push(`  docs: ${k.docs}`);
  }
  for (const t of inv.tokens) l.push(`TOKENS (${t.name}): ${t.files.join(", ")}`);
  if (inv.appRoots.length) l.push(`APPLICATION SOURCE: ${inv.appRoots.join(", ")}`);
  return l.join("\n");
}

/** The defect, as the skill needs it: what and where, with no verdict language. */
function defectBrief(cluster: FixCluster): string {
  const l: string[] = [];
  l.push(`issue ${cluster.id}: ${cluster.title}`);
  l.push(`category: ${cluster.category}/${cluster.attribute}   severity: ${cluster.severity}`);
  l.push(`seen on: ${cluster.routes.join(", ")}`);
  if (cluster.problem) l.push("", `problem: ${cluster.problem}`);
  if (cluster.expected) l.push("", `expected: ${cluster.expected}`);
  if (cluster.observed) l.push("", `observed: ${cluster.observed}`);
  return l.join("\n");
}

/**
 * Where this defect belongs, or null when the project has no design system to
 * place it in. A project without a kit has exactly one place a fix can go, so
 * spending a model call to be told so would be waste.
 */
export async function placeDefect(
  resolved: ResolvedConfig,
  cluster: FixCluster,
  inv: DesignInventory,
  model = "sonnet",
): Promise<{ placement: Placement | null; costUsd: number }> {
  if (inv.kits.length === 0) return { placement: null, costUsd: 0 };

  const skill = await loadSkill(resolved, "design-placement");
  // Capture-time facts about what was rendering on this defect's screenshots.
  // Always filled: renderSkill refuses a prompt with a slot left in it, and
  // the skill's own instructions govern the empty case.
  const observed = provenanceBrief(evidenceDir(resolved), cluster);
  const prompt = renderSkill(skill.text, {
    project: resolved.project,
    inventory: inventoryBrief(inv),
    defect: defectBrief(cluster),
    provenance: observed || "(no rendering provenance was captured for these screenshots)",
  });

  const res = await invokeClaude({
    prompt,
    // The repository, because the question is about the repository. See the
    // note at the top of this file for why that is safe here and is not safe
    // for the judge.
    cwd: resolved.projectDir,
    model,
    allowedTools: ["Read", "Grep", "Glob"],
  });

  // A reply that is not the contract is a miss, not a crash: placement is
  // advice bolted onto an issue document, and an issue with no placement
  // section is strictly better than a run that died trying to add one. The
  // cost is returned either way: a failed call still spent the money, and a
  // sweep that hid that reported an all-fail run as free.
  const cost = res.costUsd ?? 0;
  let parsed: Partial<Placement>;
  try {
    parsed = extractJson(res.text) as Partial<Placement>;
  } catch {
    return { placement: null, costUsd: cost };
  }
  if (!parsed?.placement) return { placement: null, costUsd: cost };

  // The path is checked to exist the moment it is written, which is the claim
  // the stored record has always made about it. A model that names a ghost
  // file loses the path, not the placement: "in the kit's Button" is still
  // advice, and the note says what was dropped. The single most damaging
  // reply here is a confident wrong path.
  let primaryPath = parsed.primaryPath ?? null;
  let notes = parsed.notes ?? "";
  if (primaryPath) {
    const abs = isAbsolute(primaryPath) ? primaryPath : join(resolved.projectDir, primaryPath);
    if (existsSync(abs)) {
      primaryPath = abs;
    } else {
      notes = (notes ? `${notes} ` : "") + `(the reply named ${primaryPath}, which does not exist; the path was dropped)`;
      primaryPath = null;
    }
  }

  return {
    placement: {
      placement: parsed.placement,
      primaryPath,
      symbol: parsed.symbol ?? null,
      reason: parsed.reason ?? "",
      otherCallers: typeof parsed.otherCallers === "number" ? parsed.otherCallers : null,
      blastRadius: parsed.blastRadius ?? "",
      alsoRead: Array.isArray(parsed.alsoRead) ? parsed.alsoRead : [],
      notes,
    },
    costUsd: cost,
  };
}
