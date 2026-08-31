/**
 * Controls the application built for itself, beside a kit that has them.
 *
 * A suspicion, deliberately narrow, and narrow in a way that is worth stating:
 * it fires on a named declaration whose body is raw primitives and whose name
 * matches something a design system is expected to own, in a file that imports
 * the kit nowhere. It does not fire on layout scaffolding, on anything already
 * composing the kit, or on files under the kit itself, because a kit is made of
 * raw elements by definition and flagging it would be flagging the design
 * system for existing.
 *
 * The cases this cannot see are the reason `conformance` exists: a screen that
 * imports the kit for its text and builds a button out of a styled div in the
 * same file is invisible here, and no pattern can tell that apart from
 * scaffolding.
 */
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { importsOf, sourceFiles } from "./detect-tree.js";
import type { DetectedKit, HandRoll } from "./inventory.js";

/**
 * Components the application built out of raw elements, in a project that has a
 * kit to build them from.
 *
 * This is a suspicion, deliberately narrow. It fires on a named component
 * declaration whose body is raw primitives and whose name matches something a
 * design system is expected to own. It does NOT fire on layout scaffolding, on
 * anything importing from the kit already, or on files under the kit itself,
 * because a kit is made of raw elements by definition and flagging it would be
 * flagging the design system for existing.
 */
const CONTROL_NAMES = [
  "Button", "Input", "TextField", "Select", "Checkbox", "Radio", "Switch", "Toggle",
  "Modal", "Dialog", "Tooltip", "Badge", "Chip", "Tag", "Card", "Avatar", "Alert",
  "Banner", "Spinner", "Loader", "Tabs", "Accordion", "Dropdown", "Menu", "Slider",
  "Toast", "Breadcrumb", "Pagination", "Table", "Progress",
];

const RAW_ELEMENTS = /<(div|span|button|input|select|textarea|label|a|ul|li|p|h[1-6])[\s/>]/g;

/**
 * The kit component a hand-rolled control duplicates, when the kit provides
 * one.
 *
 * Two answers, and the difference between them is the whole reason the kit is
 * read rather than assumed. `Button` means the kit ships one and the
 * application built a second: a duplicate. `null` means the kit was readable
 * and has nothing like it: still a defect, because a control assembled out of
 * raw elements beside a design system is a gap in that design system, but a
 * different one, and saying "the kit provides Button" about a kit that does not
 * would send somebody looking for an export that was never there.
 *
 * When the kit could not be read at all, the name match is the only evidence
 * available and it is used, because a suspicion is what this scan produces.
 */
export function kitEquivalent(symbol: string, kits: DetectedKit[]): string | null {
  const control = CONTROL_NAMES.find((c) => symbol === c || symbol.endsWith(c));
  if (!control) return null;
  const known = kits.flatMap((k) => k.exports);
  if (known.length === 0) return control;
  return known.find((e) => e === control) ?? null;
}

export async function scanHandRolls(
  appRoots: string[],
  kits: DetectedKit[],
  repoRoot: string,
): Promise<HandRoll[]> {
  if (kits.length === 0) return [];
  // What counts as "inside the kit", and therefore off limits.
  //
  // Component roots always. The package root only when it is a real package
  // boundary BELOW the repository: in a design system's own repository the
  // package root IS the repository, so excluding it would exclude everything
  // and silently disable the scan in the one case it matters most. A kit's own
  // docs or example app hand-rolling a control it ships is a genuine defect,
  // and it lives under that same package root.
  const kitRoots = kits
    .flatMap((k) => [...(k.packageRoot && k.packageRoot !== repoRoot ? [k.packageRoot] : []), ...k.componentRoots])
    .filter((p): p is string => !!p);
  const prefixes = kits.flatMap((k) => k.importPrefixes);
  const out: HandRoll[] = [];

  for (const root of appRoots) {
    for (const file of await sourceFiles(root)) {
      // Never flag the kit's own source. It is raw elements all the way down;
      // that is what a design system is.
      if (kitRoots.some((r) => file.startsWith(r + "/") || file === r)) continue;
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const imports = importsOf(text);
      const usesKit = imports.some((i) => prefixes.some((p) => i === p || i.startsWith(p)));

      // A component that already imports the kit is composing it, which is
      // exactly what an app is supposed to do. Only a control built from raw
      // elements with no kit import in the file is a suspected duplicate.
      if (usesKit) continue;

      // Every declaration in the file, so each one's body can be bounded by the
      // start of the next. Slicing to end-of-file instead would credit the
      // first component in a file with every element in the ones below it, and
      // the finding would name elements the component does not contain.
      const decls = [
        ...text.matchAll(/(?:export\s+)?(?:default\s+)?(?:function|const|class)\s+([A-Z][A-Za-z0-9]*)/g),
      ];
      for (const [i, m] of decls.entries()) {
        const symbol = m[1]!;
        // Named like a control the kit is expected to own. Whether the kit
        // actually owns it is a separate question, answered below.
        if (!CONTROL_NAMES.some((c) => symbol === c || symbol.endsWith(c))) continue;
        const control = kitEquivalent(symbol, kits);
        const start = m.index ?? 0;
        const end = decls[i + 1]?.index ?? text.length;
        const body = text.slice(start, end);
        const raw = [...body.matchAll(RAW_ELEMENTS)].map((r) => r[1]!);
        if (raw.length === 0) continue;
        out.push({
          path: file,
          relPath: relative(repoRoot, file),
          symbol,
          elements: [...new Set(raw)].slice(0, 6),
          candidate: control,
          line: text.slice(0, start).split("\n").length,
          foundBy: "scan",
        });
      }
    }
  }
  return out;
}
