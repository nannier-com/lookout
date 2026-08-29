// The code channel end to end: a hand-rolled component becomes a finding, that
// finding clusters per file, and re-reading the source is what closes it.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
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
