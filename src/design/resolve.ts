/**
 * The inventory lookout actually uses: what it detected, with what the project
 * declared layered over the top.
 *
 * This is the same base-plus-project-layer idiom as the rubric and the skills,
 * for the same reason. Detection is good at the common shapes and blind to an
 * in-house kit with no distinguishing marks, so the project gets the last word.
 * The two are computed separately and merged here rather than the declaration
 * short-circuiting the scan, so `lookout design-system` can show a person that
 * what they declared and what is on disk have come apart.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { detect, type DetectOptions } from "./detect.js";
import {
  loadInventory,
  saveInventory,
  type DesignInventory,
  type DetectedKit,
} from "./inventory.js";
import type { DesignSystemDeclaration, ResolvedConfig } from "../types.js";

/** Resolve a declared path against the config file, the way `rubric` is. */
function declaredPath(resolved: ResolvedConfig, p: string): string {
  if (isAbsolute(p)) return p;
  const base = resolved.configPath ? dirname(resolved.configPath) : resolved.projectDir;
  return resolvePath(base, p);
}

/**
 * Fold a declaration into the detected kits.
 *
 * A declaration that names the same kit corrects it in place; one that names a
 * kit detection missed is prepended, because a person naming their design
 * system outranks anything inferred from a dependency list.
 */
export function applyDeclaration(
  resolved: ResolvedConfig,
  inv: DesignInventory,
  decl: DesignSystemDeclaration,
): DesignInventory {
  const packageRoot = decl.packageRoot ? declaredPath(resolved, decl.packageRoot) : null;
  const componentRoots = (decl.componentRoots ?? []).map((p) => declaredPath(resolved, p));
  const notes = [...inv.notes];

  for (const p of [...(packageRoot ? [packageRoot] : []), ...componentRoots]) {
    if (!existsSync(p)) {
      notes.push(`designSystem in the config names ${p}, which does not exist on disk.`);
    }
  }

  const name = decl.name ?? inv.kits[0]?.name ?? "the project design system";
  const existing = inv.kits.find((k) => k.name === name || k.id === name);
  const declared: DetectedKit = {
    id: existing?.id ?? name,
    name,
    via: "declared",
    evidence: ["declared in .lookout/config.ts as designSystem"],
    // Declaring a path to something you cannot edit would be pointless, so a
    // declared packageRoot implies the kit is this repository's to change
    // unless the project says otherwise outright.
    editable: decl.editable ?? (packageRoot ? true : (existing?.editable ?? false)),
    packageRoot: packageRoot ?? existing?.packageRoot ?? null,
    componentRoots: componentRoots.length > 0 ? componentRoots : (existing?.componentRoots ?? []),
    importPrefixes: decl.importPrefixes ?? existing?.importPrefixes ?? [],
    ...(decl.docs ?? existing?.docs ? { docs: decl.docs ?? existing?.docs } : {}),
  };

  const rest = inv.kits.filter((k) => k !== existing);
  const tokens = [...inv.tokens];
  const tokenFiles = (decl.tokenFiles ?? []).map((p) => declaredPath(resolved, p));
  if (tokenFiles.length > 0) {
    tokens.unshift({ id: "declared", name: "declared tokens", files: tokenFiles });
  }

  return { ...inv, kits: [declared, ...rest], tokens, notes };
}

export interface ResolveOptions extends DetectOptions {
  /** Ignore the cache and re-read the repository. */
  refresh?: boolean;
  /** Write the result back to `.lookout/design-system.json`. */
  persist?: boolean;
}

/**
 * The project's design system, from cache when there is one and from the
 * repository when there is not.
 *
 * Callers on the hot path (issue materialisation) pass nothing and get the
 * cache; `lookout design-system --refresh` forces the scan. Either way the
 * config declaration is applied afterwards, so editing the config takes effect
 * without anyone remembering to refresh.
 */
export async function resolveInventory(
  resolved: ResolvedConfig,
  opts: ResolveOptions = {},
): Promise<DesignInventory> {
  let inv = opts.refresh ? null : await loadInventory(resolved);
  if (!inv) {
    inv = await detect(resolved, opts);
    if (opts.persist !== false) await saveInventory(resolved, inv);
  }
  const decl = resolved.config.designSystem;
  return decl ? applyDeclaration(resolved, inv, decl) : inv;
}
