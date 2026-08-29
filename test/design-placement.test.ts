// The placement skill and the section it writes into an issue document. The
// skill file itself is part of the contract (it ships, it is layered, it
// declares an amendment slot), so it is loaded here rather than assumed.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AMENDMENT_SLOT, loadSkill, renderSkill, shippedSkillDir } from "../src/skills/load.js";
import { inventoryBrief } from "../src/design/placement.js";
import { renderIssueDocument } from "../src/issues/document.js";
import { SKILL_NAMES } from "../src/verbs/skills.js";
import { tmpProject } from "./tmp-project.js";
import type { DesignInventory } from "../src/design/inventory.js";
import type { FixCluster } from "../src/fix/cluster.js";
import type { IssuePlacement } from "../src/backlog/lib.js";

const cluster = (over: Partial<FixCluster> = {}): FixCluster => ({
  id: "418203",
  key: "app--contrast--disabled",
  target: "app",
  category: "contrast",
  attribute: "disabled",
  defects: [{ attribute: "disabled", severity: "high", title: "Disabled button unreadable", problem: "text is too faint" }],
  severity: "high",
  title: "Disabled button unreadable",
  problem: "text is too faint",
  expected: "readable",
  observed: "not readable",
  routes: ["/settings"],
  fingerprints: ["fp1"],
  members: [],
  shotCount: 1,
  findingCount: 1,
  attemptsSpent: 0,
  verified: true,
  channel: "ai",
  ...over,
});

const placement = (over: Partial<IssuePlacement> = {}): IssuePlacement => ({
  kind: "kit-component",
  primaryPath: "/repo/packages/kit/src/atoms/Button.tsx",
  symbol: "Button",
  reason: "the disabled token is set on the component, so every caller inherits it",
  otherCallers: 37,
  blastRadius: "every disabled Button in the product",
  alsoRead: ["/repo/packages/kit/src/tokens.ts"],
  notes: "",
  kit: "@acme/kit",
  kitEditable: true,
  at: "2026-08-28T00:00:00.000Z",
  ...over,
});

describe("the design-placement skill", () => {
  test("ships, is registered, and declares the amendment slot every skill must", async () => {
    expect(SKILL_NAMES).toContain("design-placement");
    const skill = await loadSkill(null, "design-placement");
    expect(skill.output).toBe("placement-verdict-v1");
    expect(skill.version).toBeGreaterThan(0);
    // loadSkill throws when a skill has no amendment slot, so loading at all
    // proves the slot is declared. Check the shipped file to say so out loud.
    const raw = await readFile(join(shippedSkillDir("design-placement"), "SKILL.md"), "utf8");
    expect(raw).toContain(AMENDMENT_SLOT);
  });

  test("renders with the project's inventory and defect, leaving nothing unfilled", async () => {
    const skill = await loadSkill(null, "design-placement");
    const text = renderSkill(skill.text, {
      project: "demo",
      inventory: "PRIMARY KIT: @acme/kit",
      defect: "issue 418203: something",
    });
    expect(text).toContain("@acme/kit");
    expect(text).toContain("418203");
    expect(text).not.toMatch(/\{\{[a-z]+\}\}/);
  });

  test("the prompt tells the model it is not re-deciding whether the defect is real", async () => {
    const skill = await loadSkill(null, "design-placement");
    expect(skill.text).toContain("not deciding whether the defect is real");
  });
});

describe("inventoryBrief", () => {
  const inv = (editable: boolean): DesignInventory => ({
    schema: 1,
    at: "now",
    project: "demo",
    kits: [
      {
        id: "@acme/kit",
        name: "@acme/kit",
        via: "dependency",
        evidence: ["dependency @acme/kit@1"],
        editable,
        packageRoot: editable ? "/repo/packages/kit" : null,
        componentRoots: editable ? ["/repo/packages/kit/src/atoms"] : [],
        importPrefixes: ["@acme/kit"],
      },
    ],
    tokens: [],
    appRoots: ["/repo/src"],
    handRolls: [],
    adoption: null,
    notes: [],
  });

  test("says plainly when the kit is not this repository's to edit", () => {
    expect(inventoryBrief(inv(false))).toContain("NOT this repository's to edit");
    expect(inventoryBrief(inv(true))).toContain("can be changed here");
  });
});

describe("the Where this belongs section", () => {
  test("names the file, the reason, the callers and the blast radius", async () => {
    const r = tmpProject("lookout-place-doc-");
    const { markdown } = await renderIssueDocument(r, cluster(), { placement: placement() });
    expect(markdown).toContain("## Where this belongs");
    expect(markdown).toContain("/repo/packages/kit/src/atoms/Button.tsx");
    expect(markdown).toContain("37 other place(s)");
    expect(markdown).toContain("every disabled Button in the product");
    // And it must come before the defect: somebody who reads what is wrong
    // first has already started planning to fix it on the screen they saw it on.
    expect(markdown.indexOf("## Where this belongs")).toBeLessThan(markdown.indexOf("## What is wrong"));
  });

  test("warns against patching node_modules when the kit is not editable here", async () => {
    const r = tmpProject("lookout-place-up-");
    const { markdown } = await renderIssueDocument(r, cluster(), {
      placement: placement({ kitEditable: false, kind: "app-composition" }),
    });
    expect(markdown).toContain("installed dependency");
    expect(markdown).toContain("node_modules");
  });

  test("is absent entirely when the project has no design system", async () => {
    const r = tmpProject("lookout-place-none-");
    const { markdown } = await renderIssueDocument(r, cluster(), {});
    expect(markdown).not.toContain("## Where this belongs");
  });
});

describe("a code-channel issue document", () => {
  const codeCluster = cluster({
    channel: "code",
    category: "consistency",
    attribute: "hand-rolled",
    routes: ["src/screens/Checkout.tsx"],
    shotCount: 0,
    title: "PayButton is hand-rolled where @acme/kit provides Button",
    members: [
      {
        fingerprint: "fp1",
        target: "app",
        route: "src/screens/Checkout.tsx",
        state: "source",
        source: { path: "/repo/src/screens/Checkout.tsx", relPath: "src/screens/Checkout.tsx", symbol: "PayButton", line: 3 },
        category: "consistency",
        attribute: "hand-rolled",
        severity: "medium",
        status: "open",
        reason: null,
        title: "t",
        problem: "p",
        expected: "e",
        observed: "o",
        channel: "code",
        confidence: "high",
        verified: false,
        evidence: [],
        firstSeen: "r1",
        lastSeen: "r1",
        fixAttempts: 0,
        fixedIn: null,
      },
    ],
  });

  test("describes itself as read from source, not photographed", async () => {
    const r = tmpProject("lookout-code-doc-");
    const { markdown } = await renderIssueDocument(r, codeCluster, {});
    expect(markdown).toContain("found by:   source scan");
    expect(markdown).toContain("by reading the source");
    // No screenshot gallery, because there are no screenshots.
    expect(markdown).not.toContain("## Look at these first");
    expect(markdown).toContain("## Where it is");
    expect(markdown).toContain("/repo/src/screens/Checkout.tsx:3");
    expect(markdown).toContain("(PayButton)");
  });

  test("tells the fixer that verify-fix will re-read the source", async () => {
    const r = tmpProject("lookout-code-doc2-");
    const { markdown } = await renderIssueDocument(r, codeCluster, {});
    expect(markdown).toContain("re-reads the source");
    expect(markdown).toContain("verify-fix --issue 418203");
  });
});
