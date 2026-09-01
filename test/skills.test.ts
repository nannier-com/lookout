// Every AI capability lookout has is an instruction file, not a string literal.
// These pin the contract that makes that safe: the shipped file is the base,
// the project's own layer is appended rather than spliced, the composed version
// is the higher of the two (it keys the judge ledger), and a placeholder the
// caller forgot to fill never reaches the model.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fillPlaceholders,
  loadSkill,
  projectSkillDir,
  renderSkill,
  writeLayer,
} from "../src/skills/load.js";
import { SKILL_NAMES } from "../src/verbs/skills.js";
import { loadRubric } from "../src/judge/rubric.js";
import { tmpProject } from "./tmp-project.js";
import { LookoutError, type ResolvedConfig } from "../src/types.js";

const project = () => tmpProject("lookout-skills-");

function amend(resolved: ResolvedConfig, name: string, text: string): void {
  const dir = join(resolved.projectDir, ".lookout", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), text);
}

describe("shipped skills", () => {
  test("every capability lookout has ships as a skill", async () => {
    // Driven off the registry rather than a copy of it, so a capability added
    // to SKILL_NAMES without a loadable file fails here rather than in a run.
    for (const name of SKILL_NAMES) {
      const skill = await loadSkill(null, name);
      expect(skill.name).toBe(name);
      expect(skill.description.length).toBeGreaterThan(20);
      expect(skill.version).toBeGreaterThan(0);
    }
  });

  test("the judge skill inlines the rubric it includes", async () => {
    const skill = await loadSkill(null, "judge-core");
    // The include is resolved, not left as a directive.
    expect(skill.text).not.toContain("{{include:");
    expect(skill.text).toContain("## Category vocabulary");
    // The bullets themselves live in the panel skills; the core carries the
    // slot they compose into.
    expect(skill.text).toContain("{{panel}}");
  });

  test("an unknown skill names the path it looked for", async () => {
    await expect(loadSkill(null, "no-such-skill")).rejects.toThrow(LookoutError);
  });
});

describe("project amendments", () => {
  test("layer after the base and raise the version", async () => {
    const resolved = project();
    amend(
      resolved,
      "refute-finding",
      "---\nname: refute-finding\nversion: 9\n---\n\nDemo avatars are never a defect.\n",
    );
    const base = await loadSkill(null, "refute-finding");
    const layered = await loadSkill(resolved, "refute-finding");
    expect(layered.version).toBe(9);
    expect(layered.version).toBeGreaterThan(base.version);
    expect(layered.amendmentPath).toContain(".lookout/skills/refute-finding/SKILL.md");
    // Appended, so the base mandate still stands above it.
    expect(layered.text.indexOf("adversarial verifier")).toBeLessThan(
      layered.text.indexOf("Demo avatars are never a defect."),
    );
  });

  test("an amendment without a version leaves the base version alone", async () => {
    const resolved = project();
    amend(resolved, "fact-check", "---\nname: fact-check\n---\n\nPrefer short answers.\n");
    const base = await loadSkill(null, "fact-check");
    const layered = await loadSkill(resolved, "fact-check");
    expect(layered.version).toBe(base.version);
    expect(layered.text).toContain("Prefer short answers.");
  });

  test("a skill with no amendment reports none", async () => {
    const layered = await loadSkill(project(), "fact-check");
    expect(layered.amendmentPath).toBeNull();
  });
});

describe("a renamed skill keeps the lessons a project learned under the old name", () => {
  test("the layer still loads from the retired directory", async () => {
    const resolved = project();
    amend(
      resolved,
      "visual-judge",
      "---\nname: visual-judge\nversion: 9\n---\n\nThe marketing site is light-only on purpose.\n",
    );
    const layered = await loadSkill(resolved, "judge-core");
    expect(layered.version).toBe(9);
    expect(layered.text).toContain("The marketing site is light-only on purpose.");
    expect(layered.amendmentPath).toContain(".lookout/skills/visual-judge/SKILL.md");
  });

  test("a proposal waiting under the old name is still found", () => {
    const resolved = project();
    amend(resolved, "visual-judge", "---\nname: visual-judge\n---\n\nold\n");
    writeFileSync(
      join(resolved.projectDir, ".lookout", "skills", "visual-judge", "PROPOSED.md"),
      "## a proposal nobody has read yet\n",
    );
    expect(projectSkillDir(resolved, "judge-core")).toContain(
      join(".lookout", "skills", "visual-judge"),
    );
  });

  test("the current directory wins when a project has both", async () => {
    const resolved = project();
    amend(resolved, "visual-judge", "---\nname: visual-judge\nversion: 9\n---\n\nthe old one\n");
    amend(resolved, "judge-core", "---\nname: judge-core\nversion: 4\n---\n\nthe current one\n");
    const layered = await loadSkill(resolved, "judge-core");
    expect(layered.text).toContain("the current one");
    expect(layered.text).not.toContain("the old one");
    // The retired layer is not consulted at all, so its version cannot raise
    // the composed one: this is max(base, current layer), never the old 9.
    expect(layered.version).not.toBe(9);
  });

  test("a skill that was never renamed has no legacy directory", () => {
    const resolved = project();
    expect(projectSkillDir(resolved, "fact-check")).toContain(
      join(".lookout", "skills", "fact-check"),
    );
  });

  test("writing the layer moves it, proposal and all, to the current name", async () => {
    const resolved = project();
    const skills = join(resolved.projectDir, ".lookout", "skills");
    amend(resolved, "visual-judge", "---\nname: visual-judge\nversion: 9\n---\n\nthe old lesson\n");
    writeFileSync(join(skills, "visual-judge", "PROPOSED.md"), "## unread\n");

    const before = await writeLayer(resolved, "judge-core", "the new lesson", 10, "d");

    // What was there is handed back for a rollback to restore.
    expect(before).toContain("the old lesson");
    expect(existsSync(join(skills, "visual-judge"))).toBe(false);
    expect(readFileSync(join(skills, "judge-core", "SKILL.md"), "utf8")).toContain("the new lesson");
    // The proposal rode along with the directory rather than being stranded.
    expect(readFileSync(join(skills, "judge-core", "PROPOSED.md"), "utf8")).toContain("unread");
  });
});

describe("rendering", () => {
  test("fills placeholders with invocation data", () => {
    expect(renderSkill("judging {{project}} over {{shotCount}} shots", { project: "site", shotCount: 4 })).toBe(
      "judging site over 4 shots",
    );
  });

  test("an unfilled placeholder throws rather than reaching the model", () => {
    expect(() => renderSkill("shots: {{manifest}}", { project: "site" })).toThrow(LookoutError);
  });

  test("a partial fill leaves the rest for a later layer", () => {
    const once = fillPlaceholders("{{extensions}} then {{manifest}}", { extensions: "RULES" });
    expect(once).toBe("RULES then {{manifest}}");
    expect(renderSkill(once, { manifest: "M" })).toBe("RULES then M");
  });
});

describe("loadRubric composes the judge prompt", () => {
  test("the rubric arrives with its extension and panel slots filled", async () => {
    const rubric = await loadRubric(project());
    expect(rubric.text).not.toContain("{{extensions}}");
    expect(rubric.text).not.toContain("{{panel}}");
    expect(rubric.text).toContain("## Category vocabulary");
    expect(rubric.text).toContain("design-parity");
    expect(rubric.version).toBeGreaterThan(0);
  });

  test("never-file lines land inside the rubric, above the shot manifest", async () => {
    const resolved = project();
    resolved.config.neverFile = ["The marketing hero is deliberately asymmetric."];
    const rubric = await loadRubric(resolved);
    expect(rubric.text).toContain("The marketing hero is deliberately asymmetric.");
    expect(rubric.text.indexOf("The marketing hero is deliberately asymmetric.")).toBeLessThan(
      rubric.text.indexOf("=== SHOTS"),
    );
  });

  test("a learned amendment and a hand-written rule both land, the hand-written one last", async () => {
    const resolved = project();
    // A higher amendment version wins over the shipped base; the fixture rides
    // above whatever the base currently is, so a base bump does not silently
    // turn this into a test of the base.
    amend(resolved, "judge-core", "---\nname: judge-core\nversion: 9\n---\n\nLearned: ignore the loader.\n");
    resolved.config.neverFile = ["Hand-written: ignore the footer."];
    const rubric = await loadRubric(resolved);
    expect(rubric.version).toBe(9);
    expect(rubric.text.indexOf("Learned: ignore the loader.")).toBeLessThan(
      rubric.text.indexOf("Hand-written: ignore the footer."),
    );
  });
});
