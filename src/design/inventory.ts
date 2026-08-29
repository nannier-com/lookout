/**
 * What lookout knows about a project's design system, and where it keeps it.
 *
 * The inventory is a fact sheet, not a verdict: which kit the repository uses,
 * where that kit's source actually is, and how thoroughly the app consumes it.
 * Everything downstream (the issue document, the placement skill, the hand-roll
 * scan, the conformance skill) reads this rather than re-deriving it, so there
 * is exactly one answer to "what is this project built out of" per run. That
 * includes what the kit actually exports, read from the kit rather than guessed
 * from a component's name.
 *
 * It caches to `.lookout/design-system.json`, which is the project's to commit.
 * A cache is safe here because the inputs are manifests and directory layout:
 * things that change on a dependency edit, not on a render. `--refresh` rebuilds
 * it, and a declared `designSystem` in the config overrides it outright, because
 * a person who has written down what their project uses has said something the
 * scanner is not entitled to argue with.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { lookoutDir } from "../config.js";
import type { ResolvedConfig } from "../types.js";
import type { SignalStrength } from "./registry.js";

/** One place a change could belong, named concretely enough to open. */
export interface SourceLocation {
  /** Absolute path. Whoever reads this has to open it. */
  path: string;
  /** What lives here, in a few words. */
  what: string;
}

export interface DetectedKit {
  /** Registry id, or the package name for a workspace-local kit. */
  id: string;
  name: string;
  /** How the kit was found, worst-to-best: inferred < marker < dependency < declared. */
  via: SignalStrength;
  /** What proved it: a dependency name, a marker file, a config declaration. */
  evidence: string[];
  /**
   * True when the kit's source is inside this repository and therefore the
   * repository's to edit. The single most consequential field in the file: it
   * decides whether a defect in a kit component is fixed here or upstream.
   */
  editable: boolean;
  /** Absolute path to the kit's own package root, when it is in this repo. */
  packageRoot: string | null;
  /** Where its components live, when that is knowable. */
  componentRoots: string[];
  /** Import specifier prefixes that mean "this came from the kit". */
  importPrefixes: string[];
  /**
   * Component names the kit exposes, read from the kit itself.
   *
   * Empty means the kit could not be read from here, NOT that it exports
   * nothing. Everything downstream treats the two differently: an unknown kit
   * falls back to suspecting by name, and a known one is allowed to say that a
   * component it does not list is a gap rather than a duplicate.
   */
  exports: string[];
  docs?: string;
}

export interface TokenLayer {
  id: string;
  name: string;
  /** Absolute paths of the config or token files found. */
  files: string[];
}

/** One component the app built itself that the kit appears to already provide. */
export interface HandRoll {
  /** Absolute path of the file that hand-rolls it. */
  path: string;
  /** Repo-relative, for titles and fingerprints that must survive a move of the checkout. */
  relPath: string;
  /** The exported component's name, when one could be read. */
  symbol: string | null;
  /** Which primitive elements gave it away. */
  elements: string[];
  /** The kit export it most likely duplicates, when one is a plausible match. */
  candidate: string | null;
  /** Line number of the declaration, 1-based, for the finding to point at. */
  line: number;
  /**
   * Which oracle found it.
   *
   * This is not bookkeeping. A finding is closed by re-running the thing that
   * filed it, and the two oracles here do not see the same defects: the scan
   * cannot see a hand-roll in a file that imports the kit, and the skill is a
   * model call that is not spent on every `verify-fix`. Ruling a skill-found
   * finding by re-running the scan would clear it the first time anybody asked,
   * without anything having been fixed.
   */
  foundBy: "scan" | "skill";
  /** The skill's own account of what this component is, when a skill found it. */
  note?: string;
}

export interface DesignInventory {
  /** Schema version, so a stale cache is discarded rather than misread. */
  schema: 2;
  /** When it was built. */
  at: string;
  /** The project this describes, for the same reason the backlog carries it. */
  project: string;
  /** Empty when the project has no design system: a real and common answer. */
  kits: DetectedKit[];
  tokens: TokenLayer[];
  /** Directories holding the application's own screens and features. */
  appRoots: string[];
  /** Suspected hand-rolled duplicates of kit components. */
  handRolls: HandRoll[];
  /** How many import statements resolved to a kit, against how many were UI-ish. */
  adoption: { fromKit: number; total: number } | null;
  /** Anything the scan could not settle, said plainly rather than guessed at. */
  notes: string[];
}

/** The primary kit: the one a fix is aimed at when there is a choice. */
export function primaryKit(inv: DesignInventory): DetectedKit | null {
  return inv.kits[0] ?? null;
}

export function hasDesignSystem(inv: DesignInventory | null): boolean {
  return !!inv && inv.kits.length > 0;
}

export function inventoryPath(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "design-system.json");
}

export async function saveInventory(
  resolved: ResolvedConfig,
  inv: DesignInventory,
): Promise<string> {
  const p = inventoryPath(resolved);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(inv, null, 2) + "\n");
  return p;
}

/**
 * The cached inventory, or null when there is none or it is from an older
 * schema. A stale cache is dropped rather than migrated: it is rebuilt from the
 * repository in under a second, so carrying migration code for it would cost
 * more than it saves.
 */
export async function loadInventory(resolved: ResolvedConfig): Promise<DesignInventory | null> {
  const p = inventoryPath(resolved);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(await readFile(p, "utf8")) as DesignInventory;
    return raw?.schema === 2 ? raw : null;
  } catch {
    return null;
  }
}
