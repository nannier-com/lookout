// The placement skill and the section it writes into an issue document. The
// skill file itself is part of the contract (it ships, it is layered, it
// declares an amendment slot), so it is loaded here rather than assumed.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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

const MOCK = join(import.meta.dir, "mock-claude.ts");

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

  test("renders with the project's inventory, defect, and provenance, leaving nothing unfilled", async () => {
    const skill = await loadSkill(null, "design-placement");
    const text = renderSkill(skill.text, {
      project: "demo",
      inventory: "PRIMARY KIT: @acme/kit",
      defect: "issue 418203: something",
      provenance: "shot web/app/root: SaveButton src/SaveButton.tsx:12",
    });
    expect(text).toContain("@acme/kit");
    expect(text).toContain("418203");
    expect(text).toContain("src/SaveButton.tsx:12");
    expect(text).not.toMatch(/\{\{[a-z]+\}\}/);
  });

  test("the provenance block is a starting point, never a path to copy unopened", async () => {
    const skill = await loadSkill(null, "design-placement");
    expect(skill.text).toContain("into your reply without opening it");
    expect(skill.text).toContain("not conclusions about this repository");
    // The mock CLI keys placement mode off this phrase; losing it would make
    // every placement test silently exercise the judge mock instead.
    expect(skill.text).toContain("placement advisor");
  });

  test("the prompt tells the model it is not re-deciding whether the defect is real", async () => {
    const skill = await loadSkill(null, "design-placement");
    expect(skill.text).toContain("not deciding whether the defect is real");
  });
});

describe("inventoryBrief", () => {
  const inv = (editable: boolean): DesignInventory => ({
    schema: 2,
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
        exports: [],
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
    // The sentence has to read as a sentence, not as a fragment stapled to one.
    expect(markdown).toContain("This project uses **@acme/kit**. The fix belongs in @acme/kit itself");
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

describe("placing new issues in a run", () => {
  test("places issues that lack one, skips issues that have one, and caps the batch", async () => {
    const { placeNewIssues } = await import("../src/design/place-issues.js");
    const r = tmpProject("lookout-placerun-");
    // Real files: placeDefect drops a path that does not exist, and the
    // staleness sweep re-derives a placement whose path is gone, so a
    // fantasy /repo would turn this test into those tests.
    const atoms = join(r.projectDir, "packages/kit/src/atoms");
    mkdirSync(atoms, { recursive: true });
    writeFileSync(join(atoms, "Button.tsx"), "export const Button = () => null;");
    const inv: DesignInventory = {
      schema: 2,
      at: "now",
      project: "demo",
      kits: [
        {
          id: "@acme/kit",
          name: "@acme/kit",
          via: "dependency",
          evidence: ["dependency @acme/kit@1"],
          editable: true,
          packageRoot: join(r.projectDir, "packages/kit"),
          componentRoots: [atoms],
          importPrefixes: ["@acme/kit"],
          exports: [],
        },
      ],
      tokens: [],
      appRoots: [join(r.projectDir, "src")],
      handRolls: [],
      adoption: null,
      notes: [],
    };

    // Two issues: one already placed, one not. Only the unplaced one may cost
    // a call, because placement is a fact about the codebase and re-deriving it
    // on every save is the waste this design exists to avoid.
    const backlog = {
      note: "",
      project: "demo",
      updatedAt: "now",
      findings: {
        fp1: {
          fingerprint: "fp1", target: "app", route: "/a", state: "rest",
          platform: "web" as const, formFactor: "desktop" as const, scheme: "dark" as const,
          category: "contrast" as const, attribute: "x", severity: "high" as const,
          status: "open" as const, reason: null, title: "t", problem: "p",
          expected: "e", observed: "o", channel: "ai" as const, confidence: "high" as const,
          verified: true, evidence: [], firstSeen: "r", lastSeen: "r", fixAttempts: 0, fixedIn: null,
        },
        fp2: {
          fingerprint: "fp2", target: "app", route: "/b", state: "rest",
          platform: "web" as const, formFactor: "desktop" as const, scheme: "dark" as const,
          category: "spacing" as const, attribute: "y", severity: "high" as const,
          status: "open" as const, reason: null, title: "t2", problem: "p2",
          expected: "e", observed: "o", channel: "ai" as const, confidence: "high" as const,
          verified: true, evidence: [], firstSeen: "r", lastSeen: "r", fixAttempts: 0, fixedIn: null,
        },
      },
      issues: {
        "111111": { id: "111111", key: "app--contrast--x", createdAt: "now" },
        "222222": {
          id: "222222", key: "app--spacing--y", createdAt: "now",
          placement: placement({ kit: "@acme/kit", primaryPath: join(atoms, "Button.tsx") }),
        },
      },
    } as never;

    const before = process.env.LOOKOUT_CLAUDE_BIN;
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    try {
      const run = await placeNewIssues(r, backlog, inv);
      expect(run.placed).toBe(1);
      const placed = (backlog as never as { issues: Record<string, { placement?: IssuePlacement }> }).issues;
      expect(placed["111111"]!.placement?.primaryPath).toContain("Button.tsx");
      expect(placed["111111"]!.placement?.kit).toBe("@acme/kit");
      expect(placed["111111"]!.placement?.kitEditable).toBe(true);
      // Untouched: it already had one.
      expect(placed["222222"]!.placement?.reason).toBe(placement().reason);
    } finally {
      if (before === undefined) delete process.env.LOOKOUT_CLAUDE_BIN;
      else process.env.LOOKOUT_CLAUDE_BIN = before;
    }
  });

  test("does nothing at all when the project has no design system", async () => {
    const { placeNewIssues } = await import("../src/design/place-issues.js");
    const r = tmpProject("lookout-placenone-");
    const empty: DesignInventory = {
      schema: 2, at: "now", project: "d", kits: [], tokens: [],
      appRoots: [], handRolls: [], adoption: null, notes: [],
    };
    const run = await placeNewIssues(r, { findings: {}, issues: {} } as never, empty);
    expect(run.placed).toBe(0);
    expect(run.costUsd).toBe(0);
  });
});

// The candidate set and the failure accounting: placement spends on live,
// locatable work only, and every slot the sweep consumed is accounted for.
describe("who gets a placement slot", () => {
  function aiFinding(fp: string, key: string, status = "open", extra: Record<string, unknown> = {}) {
    return {
      fingerprint: fp, target: "app", route: `/${fp}`, state: "rest",
      platform: "web", formFactor: "desktop", scheme: "dark",
      category: "contrast", attribute: key, severity: "high",
      status, reason: status === "by-design" ? "intentional, per brand" : null,
      title: "t", problem: "p", expected: "e", observed: "o",
      channel: "ai", confidence: "high", verified: true, evidence: [],
      firstSeen: "r", lastSeen: "r", fixAttempts: 0, fixedIn: null,
      ...extra,
    };
  }

  const inv = (): DesignInventory => ({
    schema: 2, at: "now", project: "demo",
    kits: [{
      id: "@acme/kit", name: "@acme/kit", via: "dependency",
      evidence: ["dependency @acme/kit@1"], editable: true,
      packageRoot: "/repo/packages/kit",
      componentRoots: ["/repo/packages/kit/src/atoms"],
      importPrefixes: ["@acme/kit"], exports: [],
    }],
    tokens: [], appRoots: ["/repo/src"], handRolls: [], adoption: null, notes: [],
  });

  async function backlogOf(findings: Record<string, unknown>) {
    const { reconcileIssues } = await import("../src/issues/registry.js");
    const b = { note: "", project: "demo", updatedAt: "now", findings, issues: {} } as never;
    reconcileIssues(b, "now");
    return b as { issues: Record<string, { placement?: IssuePlacement }> };
  }

  test("only open, non-code issues are placed; closed and code-channel ones are not", async () => {
    const { placeNewIssues } = await import("../src/design/place-issues.js");
    const r = tmpProject("lookout-place-cand-");
    const backlog = await backlogOf({
      live: aiFinding("live", "a"),
      done: aiFinding("done", "b", "fixed"),
      meant: aiFinding("meant", "c", "by-design"),
      rolled: aiFinding("rolled", "d", "open", {
        channel: "code",
        route: "src/X.tsx",
        source: { path: "/repo/src/X.tsx", relPath: "src/X.tsx", symbol: "X", line: 1, foundBy: "scan" },
      }),
    });
    const before = process.env.LOOKOUT_CLAUDE_BIN;
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    try {
      const run = await placeNewIssues(r, backlog as never, inv());
      expect(run.placed).toBe(1);
      const placements = Object.values(backlog.issues).filter((i) => i.placement);
      expect(placements).toHaveLength(1);
    } finally {
      if (before === undefined) delete process.env.LOOKOUT_CLAUDE_BIN;
      else process.env.LOOKOUT_CLAUDE_BIN = before;
    }
  });

  test("the cap holds and the leftovers are counted, not dropped", async () => {
    const { placeNewIssues } = await import("../src/design/place-issues.js");
    const r = tmpProject("lookout-place-cap-");
    const backlog = await backlogOf({
      one: aiFinding("one", "a"),
      two: aiFinding("two", "b"),
    });
    const before = process.env.LOOKOUT_CLAUDE_BIN;
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    try {
      const run = await placeNewIssues(r, backlog as never, inv(), { limit: 1 });
      expect(run.placed).toBe(1);
      expect(run.skipped).toBe(1);
      expect(run.failed).toBe(0);
    } finally {
      if (before === undefined) delete process.env.LOOKOUT_CLAUDE_BIN;
      else process.env.LOOKOUT_CLAUDE_BIN = before;
    }
  });

  test("a reply that is not the contract is a counted failure that still carries its cost", async () => {
    const { placeNewIssues } = await import("../src/design/place-issues.js");
    const r = tmpProject("lookout-place-fail-");
    const backlog = await backlogOf({ one: aiFinding("one", "a") });
    const beforeBin = process.env.LOOKOUT_CLAUDE_BIN;
    const beforeReply = process.env.MOCK_PLACEMENT;
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_PLACEMENT = "no contract here";
    try {
      const run = await placeNewIssues(r, backlog as never, inv());
      expect(run.placed).toBe(0);
      expect(run.failed).toBe(1);
      expect(run.skipped).toBe(0);
      expect(run.costUsd).toBeGreaterThan(0);
    } finally {
      if (beforeBin === undefined) delete process.env.LOOKOUT_CLAUDE_BIN;
      else process.env.LOOKOUT_CLAUDE_BIN = beforeBin;
      if (beforeReply === undefined) delete process.env.MOCK_PLACEMENT;
      else process.env.MOCK_PLACEMENT = beforeReply;
    }
  });

  test("a cap of zero places nothing and says so, spending nothing", async () => {
    const { placeNewIssues } = await import("../src/design/place-issues.js");
    const r = tmpProject("lookout-place-zero-");
    const backlog = await backlogOf({ one: aiFinding("one", "a") });
    process.env.LOOKOUT_CLAUDE_BIN = join(import.meta.dir, "no-such-claude-binary");
    try {
      const run = await placeNewIssues(r, backlog as never, inv(), { limit: 0 });
      expect(run.placed).toBe(0);
      expect(run.failed).toBe(0);
      expect(run.skipped).toBe(1);
      expect(run.limit).toBe(0);
      expect(run.costUsd).toBe(0);
    } finally {
      delete process.env.LOOKOUT_CLAUDE_BIN;
    }
  });
});

// The staleness recognition the stored kit field always promised: a
// placement is re-derived exactly when the codebase moved under it.
describe("recognising a stale placement", () => {
  const kit = (over: Partial<DesignInventory["kits"][number]> = {}) => ({
    id: "@acme/kit", name: "@acme/kit", via: "dependency" as const,
    evidence: [], editable: true, packageRoot: null,
    componentRoots: [], importPrefixes: [], exports: [],
    ...over,
  });

  test("a renamed kit, a flipped editability, and a vanished path each read as stale", async () => {
    const { placementStale } = await import("../src/design/place-issues.js");
    expect(placementStale(placement({ kit: "@old/kit", primaryPath: null }), kit())).toContain("@old/kit");
    expect(placementStale(placement({ kitEditable: false, primaryPath: null }), kit())).toContain("editability");
    expect(placementStale(placement({ primaryPath: "/nowhere/Button.tsx" }), kit())).toContain("no longer exists");
    expect(placementStale(placement({ primaryPath: MOCK }), kit())).toBeNull();
    expect(placementStale(placement({ primaryPath: null }), kit())).toBeNull();
  });

  test("a stale placement is re-derived ahead of fresh issues, with a fresh stamp", async () => {
    const { placeNewIssues } = await import("../src/design/place-issues.js");
    const r = tmpProject("lookout-place-stale-");
    const atoms = join(r.projectDir, "kit/atoms");
    mkdirSync(atoms, { recursive: true });
    writeFileSync(join(atoms, "Button.tsx"), "export const Button = () => null;");
    const inv: DesignInventory = {
      schema: 2, at: "now", project: "demo",
      kits: [{ id: "@acme/kit", name: "@acme/kit", via: "dependency", evidence: [],
        editable: true, packageRoot: null, componentRoots: [atoms], importPrefixes: [], exports: [] }],
      tokens: [], appRoots: [], handRolls: [], adoption: null, notes: [],
    };
    const staleRecord = placement({ kit: "@former/kit", at: "2020-01-01T00:00:00.000Z", primaryPath: null });
    const backlog = {
      note: "", project: "demo", updatedAt: "now",
      findings: {
        fpS: { fingerprint: "fpS", target: "app", route: "/s", state: "rest",
          platform: "web", formFactor: "desktop", scheme: "dark",
          category: "contrast", attribute: "s", severity: "high", status: "open",
          reason: null, title: "t", problem: "p", expected: "e", observed: "o",
          channel: "ai", confidence: "high", verified: true, evidence: [],
          firstSeen: "r", lastSeen: "r", fixAttempts: 0, fixedIn: null },
        fpF: { fingerprint: "fpF", target: "app", route: "/f", state: "rest",
          platform: "web", formFactor: "desktop", scheme: "dark",
          category: "spacing", attribute: "f", severity: "low", status: "open",
          reason: null, title: "t", problem: "p", expected: "e", observed: "o",
          channel: "ai", confidence: "high", verified: true, evidence: [],
          firstSeen: "r", lastSeen: "r", fixAttempts: 0, fixedIn: null },
      },
      issues: {
        "333333": { id: "333333", key: "app--contrast--s", createdAt: "now", placement: staleRecord },
        "444444": { id: "444444", key: "app--spacing--f", createdAt: "now" },
      },
    } as never;

    const before = process.env.LOOKOUT_CLAUDE_BIN;
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    try {
      // A cap of one: the stale record outranks the fresh issue for the slot.
      const run = await placeNewIssues(r, backlog, inv, { limit: 1 });
      expect(run.placed).toBe(1);
      expect(run.skipped).toBe(1);
      const issues = (backlog as never as { issues: Record<string, { placement?: IssuePlacement }> }).issues;
      expect(issues["333333"]!.placement?.kit).toBe("@acme/kit");
      expect(issues["333333"]!.placement?.at).not.toBe("2020-01-01T00:00:00.000Z");
      expect(issues["444444"]!.placement).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.LOOKOUT_CLAUDE_BIN;
      else process.env.LOOKOUT_CLAUDE_BIN = before;
    }
  });

  test("a reply naming a ghost file keeps the placement and drops the path, saying so", async () => {
    const { placeDefect } = await import("../src/design/placement.js");
    const r = tmpProject("lookout-place-ghost-");
    const inv: DesignInventory = {
      schema: 2, at: "now", project: "demo",
      kits: [{ id: "@acme/kit", name: "@acme/kit", via: "dependency", evidence: [],
        editable: true, packageRoot: null, componentRoots: ["/repo/atoms"], importPrefixes: [], exports: [] }],
      tokens: [], appRoots: [], handRolls: [], adoption: null, notes: [],
    };
    const cluster = { id: "1", target: "app", category: "contrast", attribute: "x",
      severity: "high", title: "t", problem: "p", expected: "e", observed: "o",
      routes: ["/a"], fingerprints: ["fp"], members: [], shotCount: 1,
      findingCount: 1, attemptsSpent: 0, verified: true, channel: "ai",
      key: "k", defects: [] } as never as FixCluster;
    const beforeBin = process.env.LOOKOUT_CLAUDE_BIN;
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    try {
      const { placement: p } = await placeDefect(r, cluster, inv);
      expect(p).not.toBeNull();
      expect(p!.primaryPath).toBeNull();
      expect(p!.notes).toContain("does not exist");
    } finally {
      if (beforeBin === undefined) delete process.env.LOOKOUT_CLAUDE_BIN;
      else process.env.LOOKOUT_CLAUDE_BIN = beforeBin;
    }
  });

  test("the document annotates a path that vanished after placement", async () => {
    const r = tmpProject("lookout-place-doc-");
    const gone = await renderIssueDocument(r, cluster(), {
      placement: placement({ primaryPath: "/gone/Button.tsx" }),
    });
    expect(gone.markdown).toContain("/gone/Button.tsx");
    expect(gone.markdown).toContain("no longer exists");
    const fine = await renderIssueDocument(r, cluster(), {
      placement: placement({ primaryPath: MOCK }),
    });
    expect(fine.markdown).not.toContain("no longer exists");
  });
});
