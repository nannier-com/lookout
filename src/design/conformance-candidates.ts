/**
 * Which files are worth a model's attention, and how they are described to it.
 *
 * This is the half of the conformance pass that decides what gets read at all,
 * and it is the reason the pass is affordable. An application has hundreds of
 * source files; the ones that can hide a hand-rolled control are the ones dense
 * in raw interactive markup, and everything else is data, routing or
 * composition that no amount of reading will turn into a finding.
 */
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { hashText } from "./conformance-cache.js";
import { appSourceFiles } from "./detect-tree.js";
import { primaryKit, type DesignInventory, type HandRoll } from "./inventory.js";
import type { Candidate } from "./conformance-types.js";

/** Files one run will look at, unless the caller says otherwise. */
export const DEFAULT_FILE_BUDGET = 40;

/** Raw elements that carry interaction, which is what a control is made of. */
const INTERACTIVE = /<(button|input|select|textarea|a)[\s/>]|onClick|onPress|role=["'](button|tab|dialog|switch|checkbox)/g;

/** Any raw element at all. */
const RAW = /<(div|span|button|input|select|textarea|label|a|ul|li|p|h[1-6])[\s/>]/g;

/** Files that exist to be read by a machine, or to demonstrate raw markup. */
const NOT_APPLICATION_UI = /\.(test|spec|stories|d)\.[tj]sx?$|\.generated\.|__(tests|mocks|snapshots)__/;

/**
 * Which files are worth a model's attention, worst offenders first.
 *
 * The ranking is the whole reason this is affordable. An application has
 * hundreds of source files and almost all of them are data, routing or
 * composition; the ones that hide a hand-rolled control are the ones dense in
 * raw interactive markup. Interaction counts triple because a styled div that
 * takes a click is a button by every definition except its tag.
 *
 * Files the scanner already suspects are pulled to the front regardless of
 * weight: those need a verdict either way, and a suspicion nobody rules on is a
 * finding filed on a regex's say-so.
 */
export async function conformanceCandidates(
  inv: DesignInventory,
  repoRoot: string,
  budget = DEFAULT_FILE_BUDGET,
): Promise<Candidate[]> {
  const kit = primaryKit(inv);
  if (!kit) return [];
  const kitRoots = [
    ...(kit.packageRoot && kit.packageRoot !== repoRoot ? [kit.packageRoot] : []),
    ...kit.componentRoots,
  ];
  const suspicionsByFile = new Map<string, HandRoll[]>();
  for (const h of inv.handRolls) {
    suspicionsByFile.set(h.path, [...(suspicionsByFile.get(h.path) ?? []), h]);
  }

  const out: Candidate[] = [];
  for (const file of await appSourceFiles(inv.appRoots)) {
    if (kitRoots.some((r) => file.startsWith(r + "/") || file === r)) continue;
    if (NOT_APPLICATION_UI.test(file)) continue;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const raw = [...text.matchAll(RAW)].length;
    if (raw === 0) continue;
    const interactive = [...text.matchAll(INTERACTIVE)].length;
    out.push({
      path: file,
      relPath: relative(repoRoot, file),
      score: raw + interactive * 3,
      suspicions: suspicionsByFile.get(file) ?? [],
      hash: hashText(text),
    });
  }

  out.sort((a, b) => {
    if (a.suspicions.length !== b.suspicions.length) return b.suspicions.length - a.suspicions.length;
    return b.score - a.score;
  });
  return out.slice(0, Math.max(0, budget));
}

/** The file list as the skill sees it: paths to open, and what was suspected. */
export function fileBrief(batch: Candidate[]): string {
  const l: string[] = [];
  for (const c of batch) {
    l.push(`- ${c.path}`);
    for (const s of c.suspicions) {
      l.push(
        `    scanner suspects: ${s.symbol ?? "a component"} at line ${s.line}, built from ` +
          `<${s.elements.join(">, <")}>${s.candidate ? `, possibly duplicating ${s.candidate}` : ""}`,
      );
    }
  }
  return l.join("\n");
}
