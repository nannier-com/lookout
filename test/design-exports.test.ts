// Reading a kit, rather than guessing what it provides. Every fixture is a real
// package on disk for the same reason detection's are: the thing under test is
// a reader of directory trees.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportedSymbols, readKitExports } from "../src/design/exports.js";
import { detect, kitEquivalent } from "../src/design/detect.js";
import { tmpProject } from "./tmp-project.js";
import type { DetectedKit } from "../src/design/inventory.js";

function write(dir: string, rel: string, text: string): string {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
}

function kit(over: Partial<DetectedKit> = {}): DetectedKit {
  return {
    id: "@acme/kit",
    name: "@acme/kit",
    via: "inferred",
    evidence: [],
    editable: true,
    packageRoot: null,
    componentRoots: [],
    importPrefixes: ["@acme/kit"],
    exports: [],
    ...over,
  };
}

describe("exportedSymbols", () => {
  test("reads declarations, re-exports and aliases, and keeps only component names", () => {
    const names = exportedSymbols(
      [
        `export const Button = () => null;`,
        `export function Card() { return null; }`,
        `export declare const Sheet: unknown;`,
        `export { Avatar, Chip as Tag } from "./bits";`,
        `export const useTheme = () => null;`,
        `export const SPACING = 4;`,
      ].join("\n"),
    );
    expect(names).toContain("Button");
    expect(names).toContain("Card");
    expect(names).toContain("Sheet");
    expect(names).toContain("Avatar");
    // The alias is what an application imports, so the alias is the export.
    expect(names).toContain("Tag");
    expect(names).not.toContain("Chip");
    // A hook and a constant are not components, and nobody hand-rolls one.
    expect(names).not.toContain("useTheme");
    expect(names).not.toContain("SPACING");
  });
});

describe("readKitExports", () => {
  test("names components from the kit's own component directories", async () => {
    const r = tmpProject("lookout-exp-roots-");
    write(r.projectDir, "packages/kit/src/atoms/Button.tsx", "export const Button = () => null;");
    write(r.projectDir, "packages/kit/src/atoms/Sheet.tsx", "export const Sheet = () => null;");
    // Named like a component, and not one.
    write(r.projectDir, "packages/kit/src/atoms/Button.test.tsx", "export const Nope = () => null;");

    const found = await readKitExports(
      kit({ componentRoots: [join(r.projectDir, "packages/kit/src/atoms")] }),
      { searchRoots: [r.projectDir] },
    );
    expect(found).toContain("Button");
    expect(found).toContain("Sheet");
    expect(found).not.toContain("Nope");
  });

  test("falls back to the package barrel when there are no component directories", async () => {
    const r = tmpProject("lookout-exp-barrel-");
    write(
      r.projectDir,
      "packages/kit/src/index.ts",
      `export { Button, Modal } from "./internal/things";\nexport const Tooltip = () => null;`,
    );

    const found = await readKitExports(kit({ packageRoot: join(r.projectDir, "packages/kit") }), {
      searchRoots: [r.projectDir],
    });
    expect(found).toEqual(["Button", "Modal", "Tooltip"]);
  });

  test("reads an installed kit from its type declarations, which is all it can read", async () => {
    const r = tmpProject("lookout-exp-installed-");
    write(
      r.projectDir,
      "node_modules/@acme/kit/package.json",
      JSON.stringify({ name: "@acme/kit", types: "./dist/index.d.ts" }),
    );
    write(
      r.projectDir,
      "node_modules/@acme/kit/dist/index.d.ts",
      `export declare function Button(): unknown;\nexport declare const Dialog: unknown;`,
    );

    const found = await readKitExports(kit({ editable: false }), { searchRoots: [r.projectDir] });
    expect(found).toEqual(["Button", "Dialog"]);
  });

  test("an unreadable kit yields an empty list, which means unknown and not empty", async () => {
    const r = tmpProject("lookout-exp-none-");
    const found = await readKitExports(kit({ editable: false }), { searchRoots: [r.projectDir] });
    expect(found).toEqual([]);
  });
});

describe("kitEquivalent", () => {
  const shipping = [kit({ exports: ["Button", "Card"] })];

  test("names the kit export a hand-rolled control duplicates", () => {
    expect(kitEquivalent("SaveButton", shipping)).toBe("Button");
    expect(kitEquivalent("Card", shipping)).toBe("Card");
  });

  test("returns null when the kit was read and ships nothing like it", () => {
    // The control is real and the duplication claim is not: this kit has no
    // Tooltip, so saying it provides one would send somebody hunting for it.
    expect(kitEquivalent("HelpTooltip", shipping)).toBeNull();
  });

  test("falls back to the control name when the kit could not be read at all", () => {
    expect(kitEquivalent("HelpTooltip", [kit({ exports: [] })])).toBe("Tooltip");
  });

  test("says nothing about a component that is not a control", () => {
    expect(kitEquivalent("CheckoutScreen", shipping)).toBeNull();
  });
});

describe("detection fills the export list", () => {
  test("a kit's own repository reports what it ships, and a hand-roll names it", async () => {
    const r = tmpProject("lookout-exp-detect-");
    write(r.projectDir, "package.json", JSON.stringify({ name: "@acme/kit", main: "./dist/index.js" }));
    write(r.projectDir, "src/atoms/Button.tsx", "export const Button = () => null;");
    write(r.projectDir, "src/atoms/Card.tsx", "export const Card = () => null;");
    write(r.projectDir, "app/Demo.tsx", `export function DemoButton() { return <button/>; }`);
    write(r.projectDir, "app/Help.tsx", `export function HelpTooltip() { return <div/>; }`);

    const inv = await detect(r);
    expect(inv.kits[0]!.exports).toContain("Button");
    expect(inv.kits[0]!.exports).toContain("Card");

    const demo = inv.handRolls.find((h) => h.symbol === "DemoButton")!;
    expect(demo.candidate).toBe("Button");
    expect(demo.foundBy).toBe("scan");

    // The kit ships no Tooltip. It is still a hand-rolled control, and the
    // finding must not invent an export to point at.
    const help = inv.handRolls.find((h) => h.symbol === "HelpTooltip")!;
    expect(help.candidate).toBeNull();
  });
});
