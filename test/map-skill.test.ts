// The screen mapper's instructions load, carry what every skill carries, and
// render with every placeholder filled; the mock keys on the phrase the
// skill opens with, so a renamed skill is caught here rather than in a run.
import { describe, expect, test } from "bun:test";
import { buildMapPrompt } from "../src/map/prompt.js";
import { loadSkill } from "../src/skills/load.js";
import { tmpProject } from "./tmp-project.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

describe("the map-screens skill", () => {
  test("loads with its contract and the phrase the mock keys on", async () => {
    const skill = await loadSkill(null, "map-screens");
    expect(skill.output).toBe("screen-map-v1");
    expect(skill.version).toBeGreaterThan(0);
    expect(skill.text).toContain("screen mapper");
    expect(skill.text).toContain("## Who reads what you write");
    expect(skill.text).not.toContain("{{include:");
    expect(skill.text).not.toContain("{{howToOpen}}");
  });

  test("renders with every placeholder filled, paths only", async () => {
    const skill = await loadSkill(null, "map-screens");
    const prompt = buildMapPrompt(skill.text, {
      project: "proj",
      targets: [{ name: "app", url: "http://localhost:3000", routes: [{ path: "/", name: "Home", states: ["menu-open"] }] }],
      platforms: [{ kind: "web" }, { kind: "ios", deepLinkScheme: "acme" }],
      configStates: ["menu-open"],
      excluded: ["Sign out"],
      candidates: [{ path: "/repo/src/router.tsx", relPath: "src/router.tsx", score: 10, marks: ["router"], hash: "abcd" }],
      limits: { maxScreens: 40, maxDepth: 4, maxChildren: 8 },
    });
    expect(prompt).not.toMatch(/\{\{[A-Za-z0-9_:.-]+\}\}/);
    expect(prompt).toContain('Target "app" at http://localhost:3000, configured routes:\n  - /  "Home"  states: menu-open');
    expect(prompt).toContain("web, ios (deep links: acme://)");
    expect(prompt).toContain("- /repo/src/router.tsx  (router)");
    expect(prompt).toContain('"Sign out"');
    expect(prompt).toContain("at most 40 nodes per target beyond the configured");
    // The example is keyed by the scanned target, so a copied key is the right one.
    expect(prompt).toContain('"app": {');
    expect(prompt).not.toContain("exampleTarget");
  });

  test("the example's target key is the target being scanned, whatever it is called", async () => {
    const skill = await loadSkill(null, "map-screens");
    const prompt = buildMapPrompt(skill.text, {
      project: "proj",
      targets: [{ name: "docs", url: "http://localhost:8081", routes: [{ path: "/", name: "Home", states: [] }] }],
      platforms: [{ kind: "web" }],
      configStates: [],
      excluded: [],
      candidates: [],
      limits: { maxScreens: 40, maxDepth: 4, maxChildren: 8 },
    });
    expect(prompt).toContain('"docs": {');
    expect(prompt).toContain("(`docs` is one of them)");
  });

  test("a project amendment lands in the slot and raises the version", async () => {
    const r = tmpProject("lookout-map-amend-");
    const dir = join(r.projectDir, ".lookout", "skills", "map-screens");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: map-screens\nversion: 9\n---\n- The admin area is reached from the avatar menu.\n");
    const skill = await loadSkill(r, "map-screens");
    expect(skill.version).toBe(9);
    expect(skill.text).toContain("The admin area is reached from the avatar menu.");
  });
});
