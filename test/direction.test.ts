// The design direction a project declares: how it is read, how much of a
// file reaches the judge, which panel is given it, and what the refuter sees.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  capDirection,
  declaredBlock,
  directionBlock,
  loadDirection,
  presetPath,
} from "../src/judge/direction.js";
import { loadJudges, loadRubric } from "../src/judge/rubric.js";
import { PANELS } from "../src/judge/panels.js";
import { groupHash, ledgerKey, loadLedger, panelIdentity, saveLedger } from "../src/judge/ledger.js";
import { planJudging } from "../src/check/plan.js";
import { evidenceDir } from "../src/config.js";
import { loadSkill, shippedSkillDir } from "../src/skills/load.js";
import { tmpProject } from "./tmp-project.js";
import { DIRECTION_PRESETS, type LookoutConfig, type ResolvedConfig, type ShotRecord } from "../src/types.js";

function withDirection(direction: LookoutConfig["direction"]): ResolvedConfig {
  const r = tmpProject("lookout-direction-");
  mkdirSync(evidenceDir(r), { recursive: true });
  return { ...r, config: { ...r.config, direction } };
}

function shot(id: string): ShotRecord {
  const [platform, target, routeSlug, state, formFactor, scheme] = id.split("/");
  return {
    id,
    target: target!,
    route: `/${routeSlug}`,
    routeName: routeSlug!,
    state: state!,
    platform: platform as ShotRecord["platform"],
    formFactor: formFactor as ShotRecord["formFactor"],
    scheme: scheme as ShotRecord["scheme"],
    path: `${id}.png`,
    hash: `hash-${id}`,
    bytes: 1,
    width: 100,
    height: 100,
    animated: false,
    capturedAt: "2026-08-25T00:00:00Z",
    runId: "test",
    deterministicFindings: [],
  };
}

describe("the declared block", () => {
  test("is empty when the project declared nothing", () => {
    expect(declaredBlock(undefined, null)).toBe("");
    expect(declaredBlock([], null)).toBe("");
  });

  test("carries the never-file lines as bullets", () => {
    const block = declaredBlock(["the marketing hero is deliberately loud", "demo avatars repeat"], null);
    expect(block).toContain("Never-file rules:");
    expect(block).toContain("- the marketing hero is deliberately loud");
    expect(block).toContain("- demo avatars repeat");
  });

  test("names the direction by its config-relative source, after the rules", () => {
    const block = declaredBlock(["one rule"], { source: 'preset "minimalist-editorial"', text: "## Declared\n\nflat cards\n", cut: 0 });
    expect(block.indexOf("- one rule")).toBeLessThan(block.indexOf("Declared direction"));
    expect(block).toContain('Declared direction (preset "minimalist-editorial"):');
    expect(block.endsWith("flat cards")).toBe(true);
  });

  test("the panel fill is empty for no direction and headed for one", () => {
    expect(directionBlock(null)).toBe("");
    expect(directionBlock({ source: "./DESIGN.md", text: "flat cards", cut: 0 })).toContain(
      "## Declared design direction (./DESIGN.md)",
    );
  });
});

describe("capping a project's direction file", () => {
  test("leaves a file under the cap alone", () => {
    const out = capDirection("---\nname: x\ncomponents:\n  a: b\n---\n\nrules\n", 12_000);
    expect(out).toEqual({ text: "---\nname: x\ncomponents:\n  a: b\n---\n\nrules\n", cut: 0 });
  });

  test("drops the components mapping first, then cuts on a line boundary with a marker", () => {
    const fm =
      '---\nname: x\ncolors:\n  primary: "#000"\ncomponents:\n' +
      "  card:\n    rounded: md\n".repeat(400) +
      "rounded:\n  sm: 4px\n---\n";
    const body = "## Do's and Don'ts\n\n" + "- Don't do the thing.\n".repeat(900);
    const out = capDirection(fm + body, 12_000);
    expect(out.text).not.toContain("components:");
    // The sibling key after the mapping survives the drop.
    expect(out.text).toContain("rounded:\n  sm: 4px");
    expect(out.text).toContain("(cut for length:");
    expect(out.text.length).toBeLessThan(12_000 + 200);
    expect(out.cut).toBeGreaterThan(800);
  });

  test("a file with no front matter is cut on a line boundary", () => {
    const out = capDirection("rule one\n".repeat(3000), 1000);
    expect(out.text.startsWith("rule one\n")).toBe(true);
    expect(out.text).toContain("did not reach the judge");
    expect(out.text.split("(cut for length")[0]!.endsWith("rule one\n\n")).toBe(true);
    expect(out.cut).toBeGreaterThan(2000);
  });
});

describe("loading the direction", () => {
  test("nothing declared is null", async () => {
    expect(await loadDirection(tmpProject("lookout-direction-"))).toBeNull();
  });

  test("a preset resolves from the shipped skill", async () => {
    const d = await loadDirection(withDirection("utility-dense"));
    expect(d?.source).toBe('preset "utility-dense"');
    expect(d?.text).toContain("Chosen on purpose");
    expect(d?.cut).toBe(0);
  });

  test("a file resolves relative to the config, keeps its relative spelling, and is capped", async () => {
    const r = withDirection({ file: "./design/DESIGN.md" });
    mkdirSync(join(r.projectDir, "design"), { recursive: true });
    writeFileSync(join(r.projectDir, "design", "DESIGN.md"), "flat cards\n" + "- Don't do the thing.\n".repeat(900));
    const d = await loadDirection(r);
    expect(d?.source).toBe("./design/DESIGN.md");
    expect(d?.source).not.toContain(r.projectDir);
    expect(d?.text.startsWith("flat cards")).toBe(true);
    expect(d?.text).toContain("(cut for length:");
    expect(d?.cut).toBeGreaterThan(0);
  });

  test("a preset and a file compose, preset first", async () => {
    const r = withDirection({ preset: "premium-agency", file: "./DESIGN.md" });
    writeFileSync(join(r.projectDir, "DESIGN.md"), "our own rule\n");
    const d = await loadDirection(r);
    expect(d?.source).toBe('preset "premium-agency" + ./DESIGN.md');
    expect(d!.text.indexOf("Chosen on purpose")).toBeLessThan(d!.text.indexOf("our own rule"));
  });

  test("a missing file fails naming the path", async () => {
    await expect(loadDirection(withDirection({ file: "./nope.md" }))).rejects.toThrow(
      /project design direction not found: .*nope\.md/,
    );
  });

  test("every shipped preset loads and is written in the shape the judge reads", async () => {
    // The agreement test below proves the files exist. This one proves each is
    // usable: a preset that loaded but had no waiver section would silently
    // judge a declared direction against defaults, which is the failure the
    // whole mechanism exists to prevent.
    for (const preset of DIRECTION_PRESETS) {
      const d = await loadDirection(withDirection(preset));
      expect(d?.source).toBe(`preset "${preset}"`);
      expect(d?.cut).toBe(0);
      // What the direction settles, so the judge stops filing it.
      expect(d?.text).toContain("Chosen on purpose");
      // What it adds, in the vocabulary the taste panel files under.
      expect(d?.text).toContain("What this direction adds");
      expect(d?.text).toContain("Filed as taste, attribute off-direction-");
      // And the reminder that the other panels still apply. Matched without
      // the line break before it, which each file wraps differently.
      expect(d?.text.replace(/\s+/g, " ")).toContain("is filed as usual");
    }
  });

  test("every shipped preset has a file, and every file is a preset", () => {
    const dir = join(shippedSkillDir("judge-taste"), "directions");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
    expect(files).toEqual([...DIRECTION_PRESETS].sort());
    for (const p of DIRECTION_PRESETS) expect(existsSync(presetPath(p))).toBe(true);
  });
});

describe("where the direction lands", () => {
  test("only the taste panel's composed text carries it, and nothing is left unfilled", async () => {
    const r = withDirection("industrial-brutalist");
    const judges = await loadJudges(r);
    expect(judges.some((j) => j.def.direction)).toBe(true);
    for (const j of judges) {
      // The manifest placeholders are the prompt builder's to fill; the
      // direction slot is this composition's, and must be gone from every panel.
      expect(j.text).not.toContain("{{direction}}");
      expect({ panel: j.def.name, carries: j.text.includes("## Declared design direction") }).toEqual({
        panel: j.def.name,
        carries: j.def.direction === true,
      });
    }
    const rubric = await loadRubric(r);
    expect(rubric.text).toContain('## Declared design direction (preset "industrial-brutalist")');
    expect(rubric.text).not.toContain("{{direction}}");
  });

  test("with nothing declared no panel carries the heading", async () => {
    for (const j of await loadJudges(tmpProject("lookout-direction-"))) {
      expect(j.text).not.toContain("## Declared design direction");
      expect(j.text).not.toContain("{{direction}}");
    }
  });

  test("editing the direction file re-plans only the taste panel", async () => {
    const r = withDirection({ file: "./DESIGN.md" });
    writeFileSync(join(r.projectDir, "DESIGN.md"), "flat cards, one accent\n");
    const s = shot("web/app/home/rest/desktop/light");
    const refute = await loadSkill(r, "refute-finding");
    const judges = await loadJudges(r);
    const ledger = await loadLedger(r);
    for (const j of judges.filter((x) => !x.def.designOnly)) {
      const identity = panelIdentity({
        panel: j.def.name,
        version: j.version,
        panelText: j.text,
        refuteText: refute.text,
        handoffText: j.handoff,
        model: "sonnet",
      });
      ledger.entries[ledgerKey(groupHash([s]), identity)] = {
        verdict: "clean",
        panel: j.def.name,
        shotIds: [s.id],
        judgedAt: "t",
        runId: "old",
      };
    }
    await saveLedger(r, ledger);
    const before = await planJudging(r, [s], { positionals: [], flags: {} });
    expect(before.toJudge).toHaveLength(0);
    expect(before.declared).toContain("Declared direction (./DESIGN.md):");

    writeFileSync(join(r.projectDir, "DESIGN.md"), "flat cards, one accent, capsule buttons\n");
    const after = await planJudging(r, [s], { positionals: [], flags: {} });
    expect(after.toJudge.map((w) => w.panel.def.name)).toEqual(
      PANELS.filter((p) => p.direction).map((p) => p.name),
    );
  });
});
