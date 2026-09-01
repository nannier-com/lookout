// The conformance pass: choosing what to read, refusing to believe the reply,
// and merging what a model saw with what the scanner saw.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeHandRolls, readConformance } from "../src/design/conformance.js";
import { conformanceCandidates } from "../src/design/conformance-candidates.js";
import { verifyClaim } from "../src/design/conformance-batch.js";
import type { ConformanceResult } from "../src/design/conformance-types.js";
import { loadCache, readerIdentity, saveCache } from "../src/design/conformance-cache.js";
import { evidenceDir } from "../src/config.js";
import { detect } from "../src/design/detect.js";
import { tmpProject } from "./tmp-project.js";
import type { DesignInventory, DetectedKit, HandRoll } from "../src/design/inventory.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");

function write(dir: string, rel: string, text: string): string {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
}

/**
 * Run with a claude stand-in, then restore. Incidents already land in the
 * suite-wide throwaway home (test/setup.ts), and the home must NOT change
 * mid-test: the capture workspace is keyed under it, so a fixture written
 * before the swap would vanish from everything called after it.
 */
function withMockClaude<T>( fn: () => Promise<T>): Promise<T> {
  const beforeBin = process.env.LOOKOUT_CLAUDE_BIN;
  process.env.LOOKOUT_CLAUDE_BIN = MOCK;
  return fn().finally(() => {
    if (beforeBin === undefined) delete process.env.LOOKOUT_CLAUDE_BIN;
    else process.env.LOOKOUT_CLAUDE_BIN = beforeBin;
  });
}

/** An app that consumes a kit, hand-rolls a control anyway, and has scaffolding. */
function appWithKit(prefix: string) {
  const r = tmpProject(prefix);
  write(
    r.projectDir,
    "package.json",
    JSON.stringify({ name: "app", private: true, workspaces: ["packages/*"] }),
  );
  write(
    r.projectDir,
    "packages/kit/package.json",
    JSON.stringify({ name: "@acme/kit", main: "./dist/index.js" }),
  );
  write(r.projectDir, "packages/kit/src/atoms/Button.tsx", "export const Button = () => null;");
  write(r.projectDir, "packages/kit/src/atoms/Card.tsx", "export const Card = () => null;");
  return r;
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
    exports: ["Button", "Card"],
    ...over,
  };
}

function handRoll(over: Partial<HandRoll> = {}): HandRoll {
  return {
    path: "/app/src/Thing.tsx",
    relPath: "src/Thing.tsx",
    symbol: "Thing",
    elements: ["div"],
    candidate: "Card",
    line: 1,
    foundBy: "scan",
    ...over,
  };
}

describe("choosing what to read", () => {
  test("ranks suspected files first, then the ones dense in interactive markup", async () => {
    const r = appWithKit("lookout-conf-rank-");
    // Plenty of raw markup, no suspicion: interesting, but second.
    write(
      r.projectDir,
      "src/screens/Dense.tsx",
      `import { Text } from "@acme/kit";\nexport function Dense() {\n  return <div onClick={() => {}}><span/><span/><button/></div>;\n}\n`,
    );
    // A suspicion the scanner raised: must be looked at whatever its weight.
    write(r.projectDir, "src/screens/Thin.tsx", `export function ThinButton() { return <button/>; }\n`);
    // No markup at all: never worth a model call.
    write(r.projectDir, "src/screens/Data.ts", `export const rows = [1, 2, 3];\n`);
    // Exists to be raw markup.
    write(r.projectDir, "src/screens/Dense.stories.tsx", `export const Story = () => <div><button/></div>;\n`);

    const inv = await detect(r);
    const picked = await conformanceCandidates(inv, r.projectDir);
    const rel = picked.map((c) => c.relPath);

    expect(rel[0]).toBe("src/screens/Thin.tsx");
    expect(rel).toContain("src/screens/Dense.tsx");
    expect(rel).not.toContain("src/screens/Data.ts");
    expect(rel.some((p) => p.includes(".stories."))).toBe(false);
    // The kit's own components are raw elements by definition.
    expect(rel.some((p) => p.includes("packages/kit"))).toBe(false);
  });

  test("reads nothing when the project has no kit to conform to", async () => {
    const r = tmpProject("lookout-conf-nokit-");
    write(r.projectDir, "package.json", JSON.stringify({ name: "app", private: true }));
    write(r.projectDir, "src/screens/Home.tsx", `export function Home() { return <div/>; }\n`);
    const inv = await detect(r);
    expect(await conformanceCandidates(inv, r.projectDir)).toEqual([]);
  });
});

describe("verifying a claim before believing it", () => {
  const candidate = {
    path: "/app/src/Screen.tsx",
    relPath: "src/Screen.tsx",
    score: 1,
    suspicions: [],
    hash: "deadbeef",
  };
  const text = `import { Text } from "@acme/kit";\n\nexport function PriceTag() {\n  return <div/>;\n}\n`;

  test("takes the line from the file, not from the reply", () => {
    const out = verifyClaim(
      { symbol: "PriceTag", line: 999, what: "a badge", why: "raw elements", confidence: "high" },
      text,
      candidate,
      ["Badge"],
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.finding.line).toBe(3);
  });

  test("rejects a symbol the file does not declare", () => {
    const out = verifyClaim({ symbol: "Imaginary", what: "x", why: "y" }, text, candidate, []);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("not declared");
  });

  test("drops a kit component the kit does not export, and keeps the finding as a gap", () => {
    const out = verifyClaim(
      { symbol: "PriceTag", kitComponent: "Sparkline", what: "a badge", why: "raw elements" },
      text,
      candidate,
      ["Button", "Card"],
    );
    expect(out.ok).toBe(true);
    // Not "Sparkline": naming an export the kit lacks sends somebody hunting.
    if (out.ok) expect(out.finding.candidate).toBeNull();
  });

  test("refuses a symbol that is not an identifier", () => {
    // Sanitising this to nothing and searching for it would match the first
    // declaration in the file and file against a component nobody named.
    const out = verifyClaim({ symbol: "<<>>", what: "x", why: "y" }, text, candidate, []);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("not an identifier");
  });

  test("refuses a finding with no account of what the component is", () => {
    const out = verifyClaim({ symbol: "PriceTag" }, text, candidate, []);
    expect(out.ok).toBe(false);
  });
});

describe("reading the application", () => {
  test("files what the skill found, rejects what it made up, and keeps its refutations", async () => {
    const r = appWithKit("lookout-conf-read-");
    write(
      r.projectDir,
      "src/screens/Checkout.tsx",
      `import { Text } from "@acme/kit";\n\nexport function PayCard() {\n  return <div onClick={() => {}}><span/><button/></div>;\n}\n`,
    );
    const inv = await detect(r);

    const res = await withMockClaude(() => readConformance(r, inv, r.projectDir));

    expect(res.calls).toBe(1);
    expect(res.handRolls).toHaveLength(1);
    const found = res.handRolls[0]!;
    expect(found.symbol).toBe("PayCard");
    expect(found.foundBy).toBe("skill");
    expect(found.line).toBe(3);
    expect(found.note).toContain("control");
    // The kit really does export Button, so the claim survives verification.
    expect(found.candidate).toBe("Button");
    // The second claim named a symbol that is not in the file.
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]!.reason).toContain("NeverDeclaredHere");
    expect(res.examined).toContain(found.path);
  });

  test("spends nothing when there is no design system", async () => {
    const r = tmpProject("lookout-conf-none-");
    const empty: DesignInventory = {
      schema: 2, at: "now", project: "p", kits: [], tokens: [],
      appRoots: [], handRolls: [], adoption: null, notes: [],
    };
    const res = await withMockClaude(() => readConformance(r, empty, r.projectDir));
    expect(res.calls).toBe(0);
    expect(res.costUsd).toBe(0);
    expect(res.handRolls).toEqual([]);
  });

  test("reads a named file even when the ranking would never have chosen it", async () => {
    const r = appWithKit("lookout-conf-only-");
    const target = write(
      r.projectDir,
      "src/screens/Quiet.tsx",
      `export function QuietThing() {\n  return <div/>;\n}\n`,
    );
    write(
      r.projectDir,
      "src/screens/Loud.tsx",
      `import { Text } from "@acme/kit";\nexport function Loud() { return <div onClick={() => {}}><button/><button/></div>; }\n`,
    );
    const inv = await detect(r);

    const res = await withMockClaude(() =>
      readConformance(r, inv, r.projectDir, { only: [target] }),
    );
    expect(res.considered).toBe(1);
    expect(res.handRolls.map((h) => h.symbol)).toEqual(["QuietThing"]);
  });
});

describe("the cap is a cap", () => {
  test("a budget of zero reads nothing at all", async () => {
    const r = appWithKit("lookout-conf-zero-");
    write(
      r.projectDir,
      "src/screens/Checkout.tsx",
      `import { Text } from "@acme/kit";\nexport function PayCard() { return <div onClick={() => {}}><button/></div>; }\n`,
    );
    const inv = await detect(r);
    const res = await withMockClaude(() => readConformance(r, inv, r.projectDir, { fileBudget: 0 }));
    // Zero means zero. A cap that means "unlimited" at its smallest value is a
    // way to spend a lot of money by typing the smallest number there is.
    expect(res.calls).toBe(0);
    expect(res.considered).toBe(0);
  });

  test("more files than fit in one batch are all read, in a stable order", async () => {
    const r = appWithKit("lookout-conf-batches-");
    for (let i = 0; i < 10; i++) {
      write(
        r.projectDir,
        `src/screens/S${i}.tsx`,
        `import { Text } from "@acme/kit";\nexport function Screen${i}() { return <div onClick={() => {}}><button/></div>; }\n`,
      );
    }
    const inv = await detect(r);
    const res = await withMockClaude(() => readConformance(r, inv, r.projectDir));
    // Ten files is two batches, and both of them ran.
    expect(res.calls).toBe(2);
    expect(res.considered).toBe(10);
    // The mock files the first file of each batch, so two findings, and the
    // order of the report does not depend on which call returned first.
    expect(res.handRolls).toHaveLength(2);
    const again = await withMockClaude(() =>
      readConformance(r, inv, r.projectDir, { cache: false }),
    );
    expect(again.handRolls.map((h) => h.symbol)).toEqual(res.handRolls.map((h) => h.symbol));
  });
});

describe("not paying twice for the same file", () => {
  test("an unchanged file is carried from the cache, and a changed one is read again", async () => {
    const r = appWithKit("lookout-conf-cache-");
    const file = write(
      r.projectDir,
      "src/screens/Checkout.tsx",
      `import { Text } from "@acme/kit";\n\nexport function PayCard() {\n  return <div onClick={() => {}}><button/></div>;\n}\n`,
    );
    const inv = await detect(r);

    const first = await withMockClaude(() => readConformance(r, inv, r.projectDir));
    expect(first.calls).toBe(1);
    expect(first.cached).toBe(0);
    expect(first.handRolls.map((h) => h.symbol)).toEqual(["PayCard"]);

    const second = await withMockClaude(() => readConformance(r, inv, r.projectDir));
    expect(second.calls).toBe(0);
    expect(second.cached).toBe(1);
    // The verdict survives the trip through disk, not just the file list.
    expect(second.handRolls.map((h) => h.symbol)).toEqual(["PayCard"]);
    expect(second.handRolls[0]!.foundBy).toBe("skill");

    write(
      r.projectDir,
      "src/screens/Checkout.tsx",
      `import { Button, Text } from "@acme/kit";\n\nexport function PayCard() {\n  return <div><Button onClick={() => {}}>pay</Button></div>;\n}\n`,
    );
    const third = await withMockClaude(() => readConformance(r, inv, r.projectDir));
    expect(third.calls).toBe(1);
    expect(third.cached).toBe(0);
    expect(file.endsWith("Checkout.tsx")).toBe(true);
  });

  test("a cache written by a different reader is discarded whole", async () => {
    const r = appWithKit("lookout-conf-identity-");
    const skill = { version: 1, text: "read the file" };
    const a = readerIdentity(skill, "sonnet", ["Button", "Card"]);
    const b = readerIdentity({ ...skill, version: 2 }, "sonnet", ["Button", "Card"]);
    const c = readerIdentity(skill, "sonnet", ["Button", "Card", "Sheet"]);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    // The judge ledger's lesson, applied here: the composed text moves the
    // identity even when nobody bumped a version (a project amendment with no
    // version field changes the prompt), and so does the model, because a
    // verdict is that model's verdict.
    expect(readerIdentity({ ...skill, text: "read the file, and its tests" }, "sonnet", ["Button", "Card"])).not.toBe(a);
    expect(readerIdentity(skill, "opus", ["Button", "Card"])).not.toBe(a);
    // Export order is not a change; what the kit provides is a set.
    expect(readerIdentity(skill, "sonnet", ["Card", "Button"])).toBe(a);

    await saveCache(r, {
      schema: 1,
      identity: a,
      files: { "src/x.tsx": { hash: "h", findings: [], refuted: [] } },
    });
    expect(Object.keys((await loadCache(r, a)).files)).toEqual(["src/x.tsx"]);
    expect(Object.keys((await loadCache(r, b)).files)).toEqual([]);
  });

  test("a file the reply never accounted for is left unread rather than cached clean", async () => {
    const r = appWithKit("lookout-conf-unread-");
    write(
      r.projectDir,
      "src/screens/One.tsx",
      `import { Text } from "@acme/kit";\nexport function OneThing() { return <div onClick={() => {}}><button/></div>; }\n`,
    );
    write(
      r.projectDir,
      "src/screens/Two.tsx",
      `import { Text } from "@acme/kit";\nexport function TwoThing() { return <div onClick={() => {}}><button/></div>; }\n`,
    );
    const inv = await detect(r);

    const before = process.env.MOCK_CONFORMANCE;
    // A reply that mentions neither file: both are unread, and neither is
    // cached, so the next run asks again.
    process.env.MOCK_CONFORMANCE =
      "```json\n" + JSON.stringify({ findings: [], refuted: [], examined: [] }) + "\n```";
    try {
      const res = await withMockClaude(() => readConformance(r, inv, r.projectDir));
      expect(res.unread.length).toBe(2);
      expect(res.examined).toEqual([]);
      const again = await withMockClaude(() => readConformance(r, inv, r.projectDir));
      expect(again.cached).toBe(0);
    } finally {
      if (before === undefined) delete process.env.MOCK_CONFORMANCE;
      else process.env.MOCK_CONFORMANCE = before;
    }
  });
});

describe("merging the scanner and the skill", () => {
  const read = (over: Partial<ConformanceResult> = {}): ConformanceResult => ({
    handRolls: [], refuted: [], examined: [], unread: [], cached: 0, considered: 0,
    rejected: [], costUsd: 0, calls: 0,
    ...over,
  });

  test("a refuted suspicion is dropped", () => {
    const merged = mergeHandRolls(
      [handRoll({ relPath: "src/Row.tsx", symbol: "TableRow" })],
      read({ refuted: [{ relPath: "src/Row.tsx", symbol: "TableRow", why: "it is a row of data" }] }),
    );
    expect(merged).toEqual([]);
  });

  test("a control only the skill could see is added", () => {
    const merged = mergeHandRolls(
      [handRoll({ relPath: "src/A.tsx", symbol: "AButton" })],
      read({
        handRolls: [
          { ...handRoll({ relPath: "src/B.tsx", symbol: "BCard" }), foundBy: "skill", confidence: "high" },
        ],
      }),
    );
    expect(merged.map((h) => h.symbol)).toEqual(["AButton", "BCard"]);
  });

  test("the same control found twice stays one finding, kept as the scanner's", () => {
    const merged = mergeHandRolls(
      [handRoll({ relPath: "src/A.tsx", symbol: "AButton" })],
      read({
        handRolls: [
          { ...handRoll({ relPath: "src/A.tsx", symbol: "AButton" }), foundBy: "skill", confidence: "low" },
        ],
      }),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.foundBy).toBe("scan");
  });
});

// The wiring `lookout check` actually uses: read the application, merge what
// the reader found with what the scanner found, and file the result on the code
// channel.
describe("filing what the reader found", () => {
  function withReport(prefix: string) {
    const r = appWithKit(prefix);
    mkdirSync(evidenceDir(r), { recursive: true });
    writeFileSync(
      join(evidenceDir(r), "capture-report.json"),
      JSON.stringify({
        version: 1,
        project: "proj",
        runs: [{ id: "r1", startedAt: new Date(0).toISOString() }],
        shots: [],
        failures: [],
      }),
    );
    return r;
  }

  test("a control only the reader saw is filed on the code channel", async () => {
    const r = withReport("lookout-conf-merge-");
    write(
      r.projectDir,
      "src/screens/Checkout.tsx",
      `import { Text } from "@acme/kit";\n\nexport function PayCard() {\n  return <div onClick={() => {}}><button/></div>;\n}\n`,
    );

    const { loadBacklog, mergeLatest } = await import("../src/verbs/backlog.js");
    const merged = await withMockClaude(() =>
      mergeLatest(r, { scanSource: true, conformance: {} }),
    );

    expect(merged.conformance?.found).toBe(1);
    expect(merged.conformance?.read).toBe(1);
    const filed = Object.values((await loadBacklog(r)).findings);
    expect(filed).toHaveLength(1);
    expect(filed[0]!.channel).toBe("code");
    expect(filed[0]!.source?.foundBy).toBe("skill");
    expect(filed[0]!.title).toContain("PayCard");
    // The reader named a component the kit really ships, so the finding says so.
    expect(filed[0]!.title).toContain("provides Button");
  });

  test("a suspicion the reader refuted is never filed", async () => {
    const r = withReport("lookout-conf-refute-");
    // The scanner suspects this by name. The reader is told to disagree.
    write(r.projectDir, "src/screens/Row.tsx", `export function RowCard() { return <div><span/></div>; }\n`);
    write(
      r.projectDir,
      "src/screens/Uses.tsx",
      `import { Text } from "@acme/kit";\nexport const Uses = () => <Text>hi</Text>;\n`,
    );

    const before = process.env.MOCK_CONFORMANCE;
    process.env.MOCK_CONFORMANCE =
      "```json\n" +
      JSON.stringify({
        findings: [],
        refuted: [{ path: join(r.projectDir, "src/screens/Row.tsx"), symbol: "RowCard", why: "a row of data" }],
        examined: [],
      }) +
      "\n```";
    try {
      const { loadBacklog, mergeLatest } = await import("../src/verbs/backlog.js");
      const merged = await withMockClaude(() =>
        mergeLatest(r, { scanSource: true, conformance: {} }),
      );
      expect(merged.conformance?.refuted).toBe(1);
      expect(Object.values((await loadBacklog(r)).findings)).toHaveLength(0);
    } finally {
      if (before === undefined) delete process.env.MOCK_CONFORMANCE;
      else process.env.MOCK_CONFORMANCE = before;
    }
  });

  test("without the option nothing is read, and the scanner files alone", async () => {
    const r = withReport("lookout-conf-off-");
    write(r.projectDir, "src/screens/Row.tsx", `export function RowCard() { return <div><span/></div>; }\n`);
    write(
      r.projectDir,
      "src/screens/Uses.tsx",
      `import { Text } from "@acme/kit";\nexport const Uses = () => <Text>hi</Text>;\n`,
    );

    const { loadBacklog, mergeLatest } = await import("../src/verbs/backlog.js");
    const merged = await withMockClaude(() => mergeLatest(r, { scanSource: true }));
    expect(merged.conformance).toBeUndefined();
    const filed = Object.values((await loadBacklog(r)).findings);
    expect(filed).toHaveLength(1);
    expect(filed[0]!.source?.foundBy).toBe("scan");
  });

  // A refutation of an ALREADY-OPEN finding is a paid conclusion; it used to
  // evaporate. It now surfaces as a disagreement with the adjudication
  // command, and never closes anything itself.
  test("counts the disagreement and leaves the finding open", async () => {
    const r = withReport("lookout-conf-disagree-");
    write(r.projectDir, "src/screens/Row.tsx", `export function RowCard() { return <div><span/></div>; }\n`);
    write(
      r.projectDir,
      "src/screens/Uses.tsx",
      `import { Text } from "@acme/kit";\nexport const Uses = () => <Text>hi</Text>;\n`,
    );

    const { loadBacklog, mergeLatest, saveBacklog } = await import("../src/verbs/backlog.js");
    // Run one: the scanner files the suspicion as an open code finding.
    await withMockClaude(() => mergeLatest(r, { scanSource: true }));
    let backlog = await loadBacklog(r);
    expect(Object.values(backlog.findings)).toHaveLength(1);
    await saveBacklog(r, backlog);

    // Run two: the reader refutes it. The finding must survive, flagged.
    const before = process.env.MOCK_CONFORMANCE;
    process.env.MOCK_CONFORMANCE =
      "```json\n" +
      JSON.stringify({
        findings: [],
        refuted: [{ path: join(r.projectDir, "src/screens/Row.tsx"), symbol: "RowCard", why: "a row of data" }],
        examined: [],
      }) +
      "\n```";
    try {
      const merged = await withMockClaude(() => mergeLatest(r, { scanSource: true, conformance: {} }));
      expect(merged.conformance?.disagreements).toBe(1);
      backlog = await loadBacklog(r);
      const f = Object.values(backlog.findings)[0]!;
      expect(f.status).toBe("open");
    } finally {
      if (before === undefined) delete process.env.MOCK_CONFORMANCE;
      else process.env.MOCK_CONFORMANCE = before;
    }
  });
});

describe("the kit fixture", () => {
  test("detection sees the workspace kit the fixtures rely on", async () => {
    const r = appWithKit("lookout-conf-fixture-");
    write(r.projectDir, "src/screens/Home.tsx", `import { Button } from "@acme/kit";\nexport const Home = () => <Button/>;`);
    const inv = await detect(r);
    expect(inv.kits[0]!.exports).toContain("Button");
    expect(kit().exports).toContain("Card");
  });
});

describe("cache entries for deleted files", () => {
  test("a full sweep retires them; a scoped re-read never does", async () => {
    const { readConformance } = await import("../src/design/conformance.js");
    const { loadCache, readerIdentity, saveCache } = await import("../src/design/conformance-cache.js");
    const { loadSkill } = await import("../src/skills/load.js");
    const { detect, repoRootOf } = await import("../src/design/detect.js");
    const r = appWithKit("lookout-conf-prune-");
    const keep = write(
      r.projectDir,
      "src/screens/Keep.tsx",
      `import { Text } from "@acme/kit";\nexport function KeepThing() { return <div onClick={() => {}}><button/></div>; }\n`,
    );
    const inv = await detect(r);
    const repoRoot = await repoRootOf(r.projectDir);
    const skill = await loadSkill(r, "kit-conformance");
    const identity = readerIdentity(skill, "sonnet", inv.kits[0]!.exports);
    await saveCache(r, {
      schema: 1,
      identity,
      files: {
        "src/screens/Gone.tsx": { hash: "dead", findings: [], refuted: [] },
        "src/screens/Keep.tsx": { hash: "stale", findings: [], refuted: [] },
      },
    });

    const read = await withMockClaude(() => readConformance(r, inv, repoRoot, {}));
    expect(read.prunedCache).toBe(1);
    const cache = await loadCache(r, identity);
    expect(cache.files["src/screens/Gone.tsx"]).toBeUndefined();
    expect(cache.files["src/screens/Keep.tsx"]).toBeDefined();

    // A scoped re-read (only:) cannot see the whole tree's intent.
    await saveCache(r, {
      schema: 1,
      identity,
      files: { "src/screens/Gone.tsx": { hash: "dead", findings: [], refuted: [] } },
    });
    await withMockClaude(() => readConformance(r, inv, repoRoot, { only: [keep] }));
    const after = await loadCache(r, identity);
    expect(after.files["src/screens/Gone.tsx"]).toBeDefined();
  });
});
