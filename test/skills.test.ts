// Every AI capability lookout has is an instruction file, not a string literal.
// These pin the contract that makes that safe: the shipped file is the base,
// the project's own layer is appended rather than spliced, the composed version
// is the higher of the two (it keys the judge ledger), and a placeholder the
// caller forgot to fill never reaches the model.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fillPlaceholders, loadSkill, renderSkill } from "../src/skills/load.js";
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
    for (const name of ["visual-judge", "refute-finding", "verify-acceptance", "fact-check"]) {
      const skill = await loadSkill(null, name);
      expect(skill.name).toBe(name);
      expect(skill.description.length).toBeGreaterThan(20);
      expect(skill.version).toBeGreaterThan(0);
    }
  });

  test("the judge skill inlines the rubric it includes", async () => {
    const skill = await loadSkill(null, "visual-judge");
    // The include is resolved, not left as a directive.
    expect(skill.text).not.toContain("{{include:");
    expect(skill.text).toContain("## Category vocabulary");
    expect(skill.text).toContain("design-parity");
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
  test("the rubric arrives with its extension slot filled", async () => {
    const rubric = await loadRubric(project());
    expect(rubric.text).not.toContain("{{extensions}}");
    expect(rubric.text).toContain("## Category vocabulary");
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
    amend(resolved, "visual-judge", "---\nname: visual-judge\nversion: 4\n---\n\nLearned: ignore the loader.\n");
    resolved.config.neverFile = ["Hand-written: ignore the footer."];
    const rubric = await loadRubric(resolved);
    expect(rubric.version).toBe(4);
    expect(rubric.text.indexOf("Learned: ignore the loader.")).toBeLessThan(
      rubric.text.indexOf("Hand-written: ignore the footer."),
    );
  });
});
