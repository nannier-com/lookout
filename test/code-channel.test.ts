// The code channel end to end: a hand-rolled component becomes a finding, that
// finding clusters per file, and re-reading the source is what closes it.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect } from "../src/design/detect.js";
import { primaryKit } from "../src/design/inventory.js";
import {
  handRollsToFindings,
  sourceFingerprintOf,
  wasPhotographed,
  type BacklogFinding,
} from "../src/backlog/lib.js";
import { clusterKeyOf } from "../src/fix/cluster.js";
import { ruleCodeCluster } from "../src/fix/rule-code.js";
import { tmpProject } from "./tmp-project.js";
import type { FixCluster } from "../src/fix/cluster.js";
import type { HandRoll } from "../src/design/inventory.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");

/** Run with a claude stand-in and an incident log of its own, then restore. */
function withClaude<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  const beforeBin = process.env.LOOKOUT_CLAUDE_BIN;
  const beforeHome = process.env.LOOKOUT_HOME;
  process.env.LOOKOUT_CLAUDE_BIN = bin;
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


function write(dir: string, rel: string, text: string): string {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
}

/** A project that is its own kit and hand-rolls a button in its docs app. */
function kitProjectWithHandRoll() {
  const r = tmpProject("lookout-code-");
  write(r.projectDir, "package.json", JSON.stringify({ name: "@acme/kit", main: "./dist/index.js" }));
  write(r.projectDir, "src/atoms/Button.tsx", "export const Button = () => null;");
  write(r.projectDir, "src/atoms/Card.tsx", "export const Card = () => null;");
  write(
    r.projectDir,
    "app/screens/Settings.tsx",
    `export function SaveButton() {\n  return <button className="save">save</button>;\n}\n`,
  );
  return r;
}

describe("hand-rolls as findings", () => {
  test("a hand-rolled control becomes a code-channel finding with acceptance criteria", async () => {
    const r = kitProjectWithHandRoll();
    const inv = await detect(r);
    const kit = primaryKit(inv)!;
    expect(kit.id).toBe("@acme/kit");
    expect(inv.handRolls).toHaveLength(1);

    const findings = handRollsToFindings(inv.handRolls, kit.name, "app");
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.channel).toBe("code");
    expect(f.category).toBe("consistency");
    expect(f.attribute).toBe("hand-rolled");
    expect(f.title).toContain("SaveButton");
    // No screenshot, and the type guard must agree.
    expect(f.evidence).toHaveLength(0);
    expect(wasPhotographed(f as BacklogFinding)).toBe(false);
    // Criteria a source re-scan can actually decide.
    expect(f.acceptance?.length).toBeGreaterThan(0);
  });

  test("the fingerprint ignores the line number, so edits above it do not re-file", () => {
    const base = {
      target: "app",
      category: "consistency",
      attribute: "hand-rolled",
    };
    const a = sourceFingerprintOf({ ...base, source: { relPath: "src/A.tsx", symbol: "Btn" } });
    const b = sourceFingerprintOf({ ...base, source: { relPath: "src/A.tsx", symbol: "Btn" } });
    const other = sourceFingerprintOf({ ...base, source: { relPath: "src/B.tsx", symbol: "Btn" } });
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });

  test("code findings cluster per file, not into one issue for the whole app", async () => {
    const r = tmpProject("lookout-cluster-");
    write(r.projectDir, "package.json", JSON.stringify({ name: "@acme/kit", main: "./i.js" }));
    write(r.projectDir, "src/atoms/Button.tsx", "export const Button = () => null;");
    write(r.projectDir, "src/atoms/Card.tsx", "export const Card = () => null;");
    write(r.projectDir, "app/One.tsx", `export function OneButton() { return <button/>; }`);
    write(r.projectDir, "app/Two.tsx", `export function TwoButton() { return <button/>; }`);

    const inv = await detect(r);
    const findings = handRollsToFindings(inv.handRolls, "@acme/kit", "app");
    expect(findings).toHaveLength(2);
    const keys = new Set(findings.map((f) => clusterKeyOf(f as BacklogFinding)));
    expect(keys.size).toBe(2);
  });
});

describe("ruling a code finding by re-reading the source", () => {
  function clusterFor(f: ReturnType<typeof handRollsToFindings>[number]): FixCluster {
    return {
      id: "123456",
      key: clusterKeyOf(f as BacklogFinding),
      target: f.target,
      category: f.category,
      attribute: f.attribute,
      defects: [],
      severity: f.severity,
      title: f.title,
      problem: f.problem,
      expected: f.expected,
      observed: f.observed,
      routes: [f.route],
      fingerprints: [f.fingerprint],
      members: [],
      shotCount: 0,
      findingCount: 1,
      attemptsSpent: 0,
      verified: false,
      channel: "code",
    };
  }

  test("stays open while the duplicate is still in the file", async () => {
    const r = kitProjectWithHandRoll();
    const inv = await detect(r);
    const f = handRollsToFindings(inv.handRolls, primaryKit(inv)!.name, "app")[0]!;

    const ruling = await ruleCodeCluster(r, clusterFor(f));
    expect(ruling.cleared).toBe(false);
    expect(ruling.stillOpen).toBe(1);
    expect(ruling.note).toContain("still sees it");
  });

  test("clears once the component composes the kit instead", async () => {
    const r = kitProjectWithHandRoll();
    const inv = await detect(r);
    const f = handRollsToFindings(inv.handRolls, primaryKit(inv)!.name, "app")[0]!;
    const cluster = clusterFor(f);

    // The fix: compose the kit rather than raw elements.
    write(
      r.projectDir,
      "app/screens/Settings.tsx",
      `import { Button } from "@acme/kit";\nexport function SaveButton() {\n  return <Button>save</Button>;\n}\n`,
    );

    const ruling = await ruleCodeCluster(r, cluster);
    expect(ruling.cleared).toBe(true);
    expect(ruling.stillOpen).toBe(0);
  });

  test("clears when the file is deleted outright", async () => {
    const r = kitProjectWithHandRoll();
    const inv = await detect(r);
    const f = handRollsToFindings(inv.handRolls, primaryKit(inv)!.name, "app")[0]!;
    const cluster = clusterFor(f);

    rmSync(join(r.projectDir, "app/screens/Settings.tsx"));
    const ruling = await ruleCodeCluster(r, cluster);
    expect(ruling.cleared).toBe(true);
  });

  test("rules on a fresh read, never on the cached inventory", async () => {
    const r = kitProjectWithHandRoll();
    const inv = await detect(r);
    const f = handRollsToFindings(inv.handRolls, primaryKit(inv)!.name, "app")[0]!;
    const cluster = clusterFor(f);

    // Write a stale cache that still claims the duplicate is there. A ruling
    // that consulted it would keep the issue open forever after a real fix.
    const { saveInventory } = await import("../src/design/inventory.js");
    await saveInventory(r, inv);
    write(
      r.projectDir,
      "app/screens/Settings.tsx",
      `import { Button } from "@acme/kit";\nexport const SaveButton = () => <Button/>;\n`,
    );

    const ruling = await ruleCodeCluster(r, cluster);
    expect(ruling.cleared).toBe(true);
  });
});

// A defect only the conformance skill can see: the file imports the kit, which
// is exactly what makes the deterministic scan look away. Ruling one of these
// by re-running the scan would close it with nothing fixed.
describe("ruling a finding the skill found, not the scanner", () => {
  function skillProject() {
    const r = tmpProject("lookout-skillrule-");
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
    const file = write(
      r.projectDir,
      "src/screens/Checkout.tsx",
      `import { Text } from "@acme/kit";\n\nexport function PayCard() {\n  return <div onClick={() => {}}><span/><button/></div>;\n}\n`,
    );
    return { r, file };
  }

  function skillCluster(r: ReturnType<typeof tmpProject>, file: string): FixCluster {
    const handRoll: HandRoll = {
      path: file,
      relPath: "src/screens/Checkout.tsx",
      symbol: "PayCard",
      elements: ["div", "button"],
      candidate: "Button",
      line: 3,
      foundBy: "skill",
      note: "a pressable card built from raw elements",
    };
    const f = handRollsToFindings([handRoll], "@acme/kit", "app")[0]!;
    return {
      id: "654321",
      key: clusterKeyOf(f as BacklogFinding),
      target: f.target,
      category: f.category,
      attribute: f.attribute,
      defects: [],
      severity: f.severity,
      title: f.title,
      problem: f.problem,
      expected: f.expected,
      observed: f.observed,
      routes: [f.route],
      fingerprints: [f.fingerprint],
      // The members are what say which oracle has to agree it is gone.
      members: [f as BacklogFinding],
      shotCount: 0,
      findingCount: 1,
      attemptsSpent: 0,
      verified: false,
      channel: "code",
    };
  }

  test("the scanner alone never closes it: the skill is asked again", async () => {
    const { r, file } = skillProject();
    const cluster = skillCluster(r, file);

    const ruling = await withClaude(MOCK, () => ruleCodeCluster(r, cluster));
    expect(ruling.cleared).toBe(false);
    expect(ruling.note).toContain("conformance reader still sees it");
    expect(ruling.stillOpen).toBe(1);
  });

  test("closes once the reader no longer sees the control", async () => {
    const { r, file } = skillProject();
    const cluster = skillCluster(r, file);
    write(
      r.projectDir,
      "src/screens/Checkout.tsx",
      `import { Button, Text } from "@acme/kit";\n\nexport function PayCard() {\n  return <Button><Text>pay</Text></Button>;\n}\n`,
    );

    const before = process.env.MOCK_CONFORMANCE;
    process.env.MOCK_CONFORMANCE =
      "```json\n" + JSON.stringify({ findings: [], refuted: [], examined: [file] }) + "\n```";
    try {
      const ruling = await withClaude(MOCK, () => ruleCodeCluster(r, cluster));
      expect(ruling.cleared).toBe(true);
      expect(ruling.stillOpen).toBe(0);
    } finally {
      if (before === undefined) delete process.env.MOCK_CONFORMANCE;
      else process.env.MOCK_CONFORMANCE = before;
    }
  });

  test("a reader that cannot run leaves it open rather than passing it", async () => {
    const { r, file } = skillProject();
    const cluster = skillCluster(r, file);

    const ruling = await withClaude(join(import.meta.dir, "no-such-claude-binary"), () =>
      ruleCodeCluster(r, cluster),
    );
    expect(ruling.cleared).toBe(false);
    expect(ruling.scanned).toBe(false);
    expect(ruling.note).toContain("could not re-read");
  });

  test("clears when the file is gone, without spending a model call", async () => {
    const { r, file } = skillProject();
    const cluster = skillCluster(r, file);
    rmSync(file);

    const ruling = await withClaude(join(import.meta.dir, "no-such-claude-binary"), () =>
      ruleCodeCluster(r, cluster),
    );
    expect(ruling.cleared).toBe(true);
  });
});
