// The code channel end to end: a hand-rolled component becomes a finding, that
// finding clusters per file, and re-reading the source is what closes it.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { detect } from "../src/design/detect.js";
import { primaryKit } from "../src/design/inventory.js";
import {
  handRollsToFindings,
  sourceFingerprintOf,
  wasPhotographed,
  type Backlog,
  type BacklogFinding,
} from "../src/backlog/lib.js";
import { ruleCodeIssue } from "../src/verify/code.js";
import { nowIso } from "../src/util.js";
import { clusterKeyOf } from "../src/fix/cluster.js";
import { ruleCodeCluster } from "../src/fix/rule-code.js";
import { tmpProject } from "./tmp-project.js";
import type { FixCluster } from "../src/fix/cluster.js";
import type { ResolvedConfig } from "../src/types.js";
import type { HandRoll } from "../src/design/inventory.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");

/**
 * Run with a claude stand-in, then restore.
 *
 * The incident log used to need redirecting here too. It is per project now,
 * and the suite's preload keeps a no-project failure out of this repository.
 */
function withClaude<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  const beforeBin = process.env.LOOKOUT_CLAUDE_BIN;
  process.env.LOOKOUT_CLAUDE_BIN = bin;
  return fn().finally(() => {
    if (beforeBin === undefined) delete process.env.LOOKOUT_CLAUDE_BIN;
    else process.env.LOOKOUT_CLAUDE_BIN = beforeBin;
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
      platform: "web",
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
      platform: "web",
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
    // A second consumer of the kit, so the kit stays detectable when the
    // file under test is deleted. Without it, deleting Checkout.tsx removed
    // the kit's only import and the ruling exercised kit disappearance
    // rather than the deleted-file path this suite is about.
    write(
      r.projectDir,
      "src/screens/Home.tsx",
      `import { Button } from "@acme/kit";\nexport const Home = () => <Button/>;\n`,
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
      platform: "web",
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

// The ruling must resolve the kit the same way filing does (declaration
// applied), and may never close a conformance finding without the oracle that
// filed it re-firing. Each of these pinned a real auto-pass before the fix.
describe("the ruling resolves the kit the way filing does", () => {
  function codeCluster(f: BacklogFinding): FixCluster {
    return {
      id: "654321",
      key: clusterKeyOf(f),
      target: f.target,
      platform: "web",
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
      members: [f],
      shotCount: 0,
      findingCount: 1,
      attemptsSpent: 0,
      verified: false,
      channel: "code",
    };
  }

  function skillFinding(file: string, relPath: string, symbol: string): BacklogFinding {
    const handRoll: HandRoll = {
      path: file,
      relPath,
      symbol,
      elements: ["div", "button"],
      candidate: "Button",
      line: 1,
      foundBy: "skill",
      note: "a pressable card built from raw elements",
    };
    return handRollsToFindings([handRoll], "@acme/kit", "app")[0]! as BacklogFinding;
  }

  /** A project whose kit exists only as a config declaration. */
  function declaredOnlyProject() {
    const base = tmpProject("lookout-declared-");
    write(base.projectDir, "package.json", JSON.stringify({ name: "app", private: true }));
    write(base.projectDir, "design/components/Button.tsx", "export const Button = () => null;");
    write(base.projectDir, "design/components/Card.tsx", "export const Card = () => null;");
    const file = write(
      base.projectDir,
      "src/screens/Checkout.tsx",
      `export function PayCard() {\n  return <div onClick={() => {}}><span/><button/></div>;\n}\n`,
    );
    const r: ResolvedConfig = {
      ...base,
      config: {
        ...base.config,
        designSystem: { name: "@acme/kit", componentRoots: ["../design/components"] },
      },
    };
    return { r, file };
  }

  test("a kit that exists only as a config declaration still reaches the reader", async () => {
    const { r, file } = declaredOnlyProject();
    const cluster = codeCluster(skillFinding(file, "src/screens/Checkout.tsx", "PayCard"));

    // Before the fix this cleared with "no longer resolves to a design
    // system": filing applied the declaration and the ruling did not.
    const ruling = await withClaude(MOCK, () => ruleCodeCluster(r, cluster));
    expect(ruling.cleared).toBe(false);
    expect(ruling.note).toContain("conformance reader still sees it");
  });

  test("kit disappearance never auto-passes: the ruling refuses and points at adjudication", async () => {
    const r = tmpProject("lookout-kitgone-");
    write(r.projectDir, "package.json", JSON.stringify({ name: "app", private: true }));
    const file = write(
      r.projectDir,
      "src/screens/Checkout.tsx",
      `export function PayCard() { return <button/>; }\n`,
    );
    const cluster = codeCluster(skillFinding(file, "src/screens/Checkout.tsx", "PayCard"));

    const ruling = await ruleCodeCluster(r, cluster);
    expect(ruling.cleared).toBe(false);
    expect(ruling.note).toContain("no longer resolves");
    expect(ruling.note).toContain("by-design");
    expect(ruling.stillOpen).toBe(1);
  });

  /** The workspace shape the skill-found tests use: a real, detectable kit. */
  function detectableKitProject() {
    const r = tmpProject("lookout-provenance-");
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

  test("a member with a source path and no foundBy is re-read by the skill, not cleared by scanner silence", async () => {
    const { r, file } = detectableKitProject();
    const filed = skillFinding(file, "src/screens/Checkout.tsx", "PayCard");
    // A finding filed before provenance was recorded: same defect, no foundBy.
    const legacy: BacklogFinding = { ...filed, source: { ...filed.source!, foundBy: undefined } };
    const cluster = codeCluster(legacy);

    const ruling = await withClaude(MOCK, () => ruleCodeCluster(r, cluster));
    expect(ruling.cleared).toBe(false);
    expect(ruling.note).toContain("conformance reader still sees it");
  });

  test("a member with no source path refuses to clear rather than passing on nothing", async () => {
    const { r, file } = detectableKitProject();
    const filed = skillFinding(file, "src/screens/Checkout.tsx", "PayCard");
    const pathless: BacklogFinding = { ...filed, source: undefined };
    const cluster = codeCluster(pathless);

    const ruling = await ruleCodeCluster(r, cluster);
    expect(ruling.cleared).toBe(false);
    expect(ruling.note).toContain("cannot be re-checked");
  });

  test("verify-fix's --model reaches the conformance re-read", async () => {
    const { r, file } = detectableKitProject();
    const filed = skillFinding(file, "src/screens/Checkout.tsx", "PayCard");
    const cluster = codeCluster(filed);
    const before: Backlog = {
      note: "",
      project: r.project,
      updatedAt: nowIso(),
      findings: { [filed.fingerprint]: filed },
      issues: {},
    };

    const argvFile = join(r.projectDir, ".lookout", "mock-argv.jsonl");
    const prev = process.env.MOCK_ARGV_FILE;
    process.env.MOCK_ARGV_FILE = argvFile;
    try {
      await withClaude(MOCK, () =>
        ruleCodeIssue(r, cluster, before, {
          attempt: 1,
          maxAttempts: 3,
          issueId: "654321",
          commit: null,
          note: null,
          json: true,
          model: "opus",
        }),
      );
    } finally {
      if (prev === undefined) delete process.env.MOCK_ARGV_FILE;
      else process.env.MOCK_ARGV_FILE = prev;
    }

    const calls = readFileSync(argvFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      const i = argv.indexOf("--model");
      expect(i).toBeGreaterThan(-1);
      expect(argv[i + 1]).toBe("opus");
    }
  });
});

// The code pass rules each criterion by what decided it, never blanket-met.
describe("code-channel acceptance stays honest", () => {
  test("a legacy screenshot criterion on a code issue goes not-verifiable, the rest carry notes", async () => {
    const { r, file } = (() => {
      const r = tmpProject("lookout-code-accept-");
      write(r.projectDir, "package.json", JSON.stringify({ name: "app", private: true, workspaces: ["packages/*"] }));
      write(r.projectDir, "packages/kit/package.json", JSON.stringify({ name: "@acme/kit", main: "./i.js" }));
      write(r.projectDir, "packages/kit/src/atoms/Button.tsx", "export const Button = () => null;");
      write(r.projectDir, "packages/kit/src/atoms/Card.tsx", "export const Card = () => null;");
      write(r.projectDir, "src/Home.tsx", 'import { Button } from "@acme/kit";\nexport const Home = () => <Button/>;\n');
      const file = write(r.projectDir, "src/Checkout.tsx", "export function PayCard() { return <button/>; }\n");
      return { r, file };
    })();
    const handRoll: HandRoll = {
      path: file, relPath: "src/Checkout.tsx", symbol: "PayCard",
      elements: ["button"], candidate: "Button", line: 1, foundBy: "scan",
    };
    const f = handRollsToFindings([handRoll], "@acme/kit", "app")[0]! as BacklogFinding;
    (f as { status: string }).status = "open";
    f.firstSeen = nowIso();
    f.lastSeen = nowIso();
    f.fixAttempts = 0;
    const before: Backlog = {
      note: "", project: r.project, updatedAt: nowIso(),
      findings: { [f.fingerprint]: f }, issues: {},
    };
    // Reconcile mints the issue and composes acceptance with the code
    // universal; then plant a legacy screenshot criterion beside it, the way
    // an issue filed before the code text existed would carry one.
    const { reconcileIssues } = await import("../src/issues/registry.js");
    reconcileIssues(before, nowIso());
    const issueId = Object.keys(before.issues)[0]!;
    const record = before.issues[issueId]!;
    record.acceptance!.push({
      id: "legacy1",
      text: "Every screenshot this issue was filed against was re-captured, and at least one changed.",
      source: "universal",
      verdict: "pending",
    });

    // Fix the duplicate so the scan clears and the pass path runs.
    write(r.projectDir, "src/Checkout.tsx", 'import { Button } from "@acme/kit";\nexport const PayCard = () => <Button/>;\n');
    const code = await ruleCodeIssue(r, await findCluster(before, issueId), before, {
      attempt: 1, maxAttempts: 2, issueId, commit: null, note: null, json: true,
    });
    expect(code).toBe(0);

    const ruled = before.issues[issueId]!.acceptance!;
    // The save's recomposition drops the legacy screenshot criterion: its id
    // is not among the ids this all-code membership composes, so the record
    // stops claiming a capture that never happened. What stays is the code
    // universal, met with a note naming its oracle.
    expect(ruled.find((c) => c.id === "legacy1")).toBeUndefined();
    expect(ruled.some((c) => c.text.includes("screenshot"))).toBe(false);
    const codeUniversal = ruled.find((c) => c.source === "universal")!;
    expect(codeUniversal.verdict).toBe("met");
    expect(codeUniversal.note).toContain("re-reading the source");
    for (const c of ruled.filter((x) => x.source === "judge")) {
      expect(c.verdict).toBe("met");
      expect(c.note).toContain("re-reading the source");
    }
  });
});

async function findCluster(backlog: Backlog, id: string): Promise<FixCluster> {
  const { findIssue } = await import("../src/issues/registry.js");
  return findIssue(backlog, id, { statuses: ["open"] })!;
}
