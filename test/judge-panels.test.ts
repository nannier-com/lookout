// The panel registry is the partition of the category vocabulary, and the
// panel skill files are the prose side of the same partition. These hold the
// two together: the registry covers CATEGORIES exactly, each skill file's
// bullets are set-equal to its registry entry, the core carries the slot
// rather than bullets of its own, and the composed rubric still contains
// every category exactly once. The refuter names categories too, in its two
// bands, so it is held to the same vocabulary.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkill } from "../src/skills/load.js";
import { CATEGORIES, loadRubric } from "../src/judge/rubric.js";
import { applicablePanels, isJudgeFamily, licensedSkills, panelOf, PANELS } from "../src/judge/panels.js";
import { tmpProject } from "./tmp-project.js";
import { LookoutError, type ResolvedConfig, type ShotRecord } from "../src/types.js";

const project = () => tmpProject("lookout-panels-");

function amend(resolved: ResolvedConfig, name: string, text: string): void {
  const dir = join(resolved.projectDir, ".lookout", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), text);
}

/**
 * The category vocabulary section alone. The severity ladder and the region
 * vocabulary use the same bullet shape (and the regions even reuse the word
 * "content"), so a bullet count over the whole text would lie.
 */
function vocabularySection(text: string): string {
  const heading = "## Category vocabulary";
  const start = text.indexOf(heading);
  if (start === -1) throw new Error("no category vocabulary section in this text");
  const end = text.indexOf("\n## ", start + heading.length);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

function bulletsOf(text: string): string[] {
  return [...text.matchAll(/^- ([a-z0-9-]+):/gm)].map((m) => m[1]!);
}

describe("the registry partitions the vocabulary", () => {
  test("every category is owned by exactly one panel", () => {
    const owned = PANELS.flatMap((p) => p.categories);
    expect([...owned].sort()).toEqual([...CATEGORIES].sort());
    expect(new Set(owned).size).toBe(owned.length);
  });

  test("panelOf is total over CATEGORIES and refuses anything else", () => {
    for (const category of CATEGORIES) {
      expect(panelOf(category).categories).toContain(category);
    }
    expect(() => panelOf("not-a-category")).toThrow(LookoutError);
  });

  test("panel names survive a ledger key", () => {
    for (const p of PANELS) expect(p.name).not.toContain("@");
  });

  test("the design-parity panel joins only a design-bearing group", () => {
    const plain = applicablePanels([{} as ShotRecord]);
    expect(plain.map((p) => p.name)).not.toContain("judge-design-parity");
    expect(plain.length).toBe(PANELS.length - 1);
    const withDesign = applicablePanels([{} as ShotRecord, { design: "/m.png" } as ShotRecord]);
    expect(withDesign.length).toBe(PANELS.length);
  });
});

describe("the pair rule spans the family, never a sibling", () => {
  test("a panel signal licenses that panel, the core, and the refuter", () => {
    const licensed = licensedSkills(new Set(["judge-visibility"]));
    expect([...licensed].sort()).toEqual(["judge-visibility", "refute-finding", "visual-judge"]);
  });

  test("core and refuter signals license each other and no panel", () => {
    expect([...licensedSkills(new Set(["visual-judge"]))].sort()).toEqual([
      "refute-finding",
      "visual-judge",
    ]);
    expect([...licensedSkills(new Set(["refute-finding"]))].sort()).toEqual([
      "refute-finding",
      "visual-judge",
    ]);
  });

  test("a signal outside the family licenses only itself", () => {
    expect([...licensedSkills(new Set(["kit-conformance"]))]).toEqual(["kit-conformance"]);
    expect(isJudgeFamily("kit-conformance")).toBe(false);
    expect(isJudgeFamily("judge-craft")).toBe(true);
  });
});

describe("the skill files and the registry cannot drift", () => {
  test("each panel skill lists exactly its registry categories", async () => {
    for (const p of PANELS) {
      const skill = await loadSkill(null, p.name);
      expect(bulletsOf(skill.text).sort()).toEqual([...p.categories].sort());
    }
  });

  test("the core carries the heading and the slot, not the bullets", async () => {
    const core = await loadSkill(null, "visual-judge");
    const section = vocabularySection(core.text);
    expect(section).toContain("{{panel}}");
    expect(bulletsOf(section)).toEqual([]);
  });

  test("the refuter's two bands name every category except design-parity", async () => {
    const refute = await loadSkill(null, "refute-finding");
    const bands = [...refute.text.matchAll(/\*\*Something (?:is broken|breaks a principle)\*\*\s*\(([^)]+)\)/g)];
    expect(bands.length).toBe(2);
    const named = bands.flatMap((m) => m[1]!.split(",").map((s) => s.trim()));
    const expected = CATEGORIES.filter((c) => c !== "design-parity");
    expect([...named].sort()).toEqual([...expected].sort());
  });
});

describe("the composed rubric", () => {
  test("carries every category exactly once, in its vocabulary section", async () => {
    const rubric = await loadRubric(project());
    expect(bulletsOf(vocabularySection(rubric.text)).sort()).toEqual([...CATEGORIES].sort());
  });

  test("still finds the hand-off at its new home", async () => {
    const rubric = await loadRubric(project());
    expect(rubric.handoff).toContain("Comparing against a design hand-off");
  });

  test("a panel amendment lands inside the vocabulary and raises the version", async () => {
    const resolved = project();
    amend(
      resolved,
      "judge-craft",
      "---\nname: judge-craft\nversion: 9\n---\n\nLearned: the dashboard hero is deliberately loud.\n",
    );
    const rubric = await loadRubric(resolved);
    expect(rubric.version).toBe(9);
    expect(rubric.text).toContain("Learned: the dashboard hero is deliberately loud.");
    expect(rubric.text.indexOf("Learned: the dashboard hero")).toBeLessThan(
      rubric.text.indexOf("## Region vocabulary"),
    );
  });
});
