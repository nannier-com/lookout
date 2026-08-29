// The conformance pass: choosing what to read, refusing to believe the reply,
// and merging what a model saw with what the scanner saw.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conformanceCandidates,
  mergeHandRolls,
  readConformance,
  verifyClaim,
  type ConformanceResult,
} from "../src/design/conformance.js";
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

/** Run with a claude stand-in and an incident log of its own, then restore. */
function withMockClaude<T>( fn: () => Promise<T>): Promise<T> {
  const beforeBin = process.env.LOOKOUT_CLAUDE_BIN;
  const beforeHome = process.env.LOOKOUT_HOME;
  process.env.LOOKOUT_CLAUDE_BIN = MOCK;
  // Incidents are appended to the operator's home by default, and a test run
  // has no business writing there.
  process.env.LOOKOUT_HOME = mkdtempSync(join(tmpdir(), "lookout-home-"));
  return fn().finally(() => {
    if (beforeBin === undefined) delete process.env.LOOKOUT_CLAUDE_BIN;
    else process.env.LOOKOUT_CLAUDE_BIN = beforeBin;
    if (beforeHome === undefined) delete process.env.LOOKOUT_HOME;
    else process.env.LOOKOUT_HOME = beforeHome;
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
  const candidate = { path: "/app/src/Screen.tsx", relPath: "src/Screen.tsx", score: 1, suspicions: [] };
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

describe("merging the scanner and the skill", () => {
  const read = (over: Partial<ConformanceResult> = {}): ConformanceResult => ({
    handRolls: [], refuted: [], examined: [], considered: 0, rejected: [], costUsd: 0, calls: 0,
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

describe("the kit fixture", () => {
  test("detection sees the workspace kit the fixtures rely on", async () => {
    const r = appWithKit("lookout-conf-fixture-");
    write(r.projectDir, "src/screens/Home.tsx", `import { Button } from "@acme/kit";\nexport const Home = () => <Button/>;`);
    const inv = await detect(r);
    expect(inv.kits[0]!.exports).toContain("Button");
    expect(kit().exports).toContain("Card");
  });
});
