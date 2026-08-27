// Numbered issues, and the folder each one owns.
//
// The id is drawn at random, which is the whole reason these exist: a derived
// id could always be recomputed, so nothing had to remember it. A random one is
// remembered or it is lost, and losing it orphans the folder named after it.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ISSUE_ID_MAX, ISSUE_ID_MIN, isIssueId, mintIssueId } from "../src/issues/id.js";
import { issueByKey, issuesOf, reconcileIssues } from "../src/issues/registry.js";
import { checkBacklog } from "../src/backlog/lib.js";
import { issueDir, issueShotsDir } from "../src/issues/paths.js";
import { loadBacklog, saveBacklog } from "../src/verbs/backlog.js";
import { emptyBacklog, type Backlog, type BacklogFinding } from "../src/backlog/lib.js";
import { tmpProject } from "./tmp-project.js";
import { LookoutError, type ResolvedConfig } from "../src/types.js";

function finding(over: Partial<BacklogFinding> = {}): BacklogFinding {
  const route = over.route ?? "/dash";
  const attribute = over.attribute ?? "theme-not-switching";
  const scheme = over.scheme ?? "dark";
  return {
    fingerprint: `app.${route}.rest.desktop.${scheme}.color-scheme.${attribute}`,
    target: "app",
    route,
    state: "rest",
    platform: "web",
    formFactor: "desktop",
    scheme,
    category: "color-scheme",
    attribute,
    severity: "high",
    status: "open",
    reason: null,
    title: "Light scheme renders the dark theme",
    problem: "The light capture shows the dark palette.",
    expected: "A light page background with dark text.",
    observed: "Indistinguishable from the dark capture.",
    channel: "ai",
    confidence: "high",
    verified: true,
    evidence: [
      {
        shotId: `web/app${route}/rest/desktop/${scheme}`,
        path: `web/app${route}/rest--desktop-${scheme}.png`,
        hash: "h1",
        runId: "r1",
      },
    ],
    firstSeen: "r1",
    lastSeen: "r1",
    fixAttempts: 0,
    fixedIn: null,
    ...over,
  } as BacklogFinding;
}

function backlogOf(findings: BacklogFinding[]): Backlog {
  const b = emptyBacklog("app", "2026-01-01T00:00:00.000Z");
  for (const f of findings) b.findings[f.fingerprint] = f;
  return b;
}

function writeBacklog(r: ResolvedConfig, findings: BacklogFinding[]): void {
  writeFileSync(
    join(r.projectDir, ".lookout", "backlog.json"),
    JSON.stringify({
      note: "",
      project: "app",
      updatedAt: new Date(0).toISOString(),
      findings: Object.fromEntries(findings.map((f) => [f.fingerprint, f])),
    }),
  );
}

/** A screenshot on disk where the evidence store keeps it. */
function writeShot(r: ResolvedConfig, relPath: string, bytes = "png"): void {
  const p = join(r.projectDir, ".lookout", "evidence", relPath);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, bytes);
}

describe("minting an id", () => {
  test("is always six digits, in range", () => {
    for (const roll of [0, 0.5, 0.999999]) {
      const id = mintIssueId(new Set(), () => roll);
      expect(isIssueId(id)).toBe(true);
      expect(id).toHaveLength(6);
      expect(Number(id)).toBeGreaterThanOrEqual(ISSUE_ID_MIN);
      expect(Number(id)).toBeLessThanOrEqual(ISSUE_ID_MAX);
    }
  });

  test("draws again when the number is already taken", () => {
    const rolls = [0, 0, 0.5];
    let i = 0;
    const id = mintIssueId(new Set(["100000"]), () => rolls[i++] ?? 0.9);
    expect(id).not.toBe("100000");
    expect(isIssueId(id)).toBe(true);
  });

  test("gives up loudly rather than looping forever", () => {
    expect(() => mintIssueId(new Set(["100000"]), () => 0)).toThrow(LookoutError);
  });
});

describe("the registry", () => {
  test("one id per root cause, not one per finding", () => {
    // Same target, category and attribute on two routes and two schemes: one
    // root cause, so one number.
    const b = backlogOf([
      finding(),
      finding({ fingerprint: "b", route: "/settings" }),
      finding({ fingerprint: "c", scheme: "light" }),
    ]);
    const minted = reconcileIssues(b, "2026-01-01T00:00:00.000Z");
    expect(minted).toHaveLength(1);
    expect(Object.keys(b.issues)).toHaveLength(1);
    expect(issueByKey(b, "app--color-scheme--theme-not-switching")).toBeDefined();
  });

  test("is idempotent, and a later finding on the same cause keeps the number", () => {
    const b = backlogOf([finding()]);
    const [first] = reconcileIssues(b, "t");
    expect(reconcileIssues(b, "t")).toHaveLength(0);

    const later = finding({ fingerprint: "later", route: "/new" });
    b.findings[later.fingerprint] = later;
    expect(reconcileIssues(b, "t")).toHaveLength(0);
    expect(issueByKey(b, first!.key)!.id).toBe(first!.id);
  });

  test("a new root cause gets a new number, and the old one keeps its own", () => {
    const b = backlogOf([finding()]);
    const [first] = reconcileIssues(b, "t");
    b.findings.other = finding({ fingerprint: "other", category: "spacing", attribute: "gap" });
    const minted = reconcileIssues(b, "t");
    expect(minted).toHaveLength(1);
    expect(minted[0]!.id).not.toBe(first!.id);
    expect(Object.keys(b.issues)).toHaveLength(2);
  });

  test("an adjudicated issue keeps its number: nothing is ever pruned", () => {
    const b = backlogOf([finding({ status: "by-design", reason: "deliberate" })]);
    expect(reconcileIssues(b, "t")).toHaveLength(1);
    // Even with no open findings left, the number stands.
    b.findings[Object.keys(b.findings)[0]!]!.status = "fixed";
    expect(reconcileIssues(b, "t")).toHaveLength(0);
    expect(Object.keys(b.issues)).toHaveLength(1);
  });
});

describe("ids survive the round trip", () => {
  test("a backlog written before ids existed is repaired on load, once", async () => {
    const r = tmpProject("lookout-issues-");
    writeBacklog(r, [finding()]);

    const first = await loadBacklog(r);
    const id = Object.keys(first.issues)[0]!;
    expect(isIssueId(id)).toBe(true);

    // Written straight back: a random id that was drawn and forgotten would
    // come back different, and the folder named after the first would be lost.
    const onDisk = JSON.parse(
      readFileSync(join(r.projectDir, ".lookout", "backlog.json"), "utf8"),
    ) as Backlog;
    expect(Object.keys(onDisk.issues)).toEqual([id]);

    const second = await loadBacklog(r);
    expect(Object.keys(second.issues)).toEqual([id]);
  });
});

describe("the issue folder", () => {
  test("holds the record, the document and the screenshots", async () => {
    const r = tmpProject("lookout-issues-");
    writeShot(r, "web/app/dash/rest--desktop-dark.png");
    const b = backlogOf([finding()]);
    await saveBacklog(r, b);

    const id = Object.keys(b.issues)[0]!;
    const dir = issueDir(r, id);
    expect(existsSync(join(dir, "issue.json"))).toBe(true);
    expect(existsSync(join(dir, "ISSUE.md"))).toBe(true);

    const doc = JSON.parse(readFileSync(join(dir, "issue.json"), "utf8")) as Record<string, unknown>;
    expect(doc.id).toBe(id);
    expect(doc.key).toBe("app--color-scheme--theme-not-switching");
    expect(doc.status).toBe("open");
    expect(doc.severity).toBe("high");

    // The pixels come with it: a dossier that points into a gitignored
    // directory is a dossier full of dead links the first time it is cleaned.
    const shots = readdirSync(issueShotsDir(r, id));
    expect(shots).toEqual(["web-app-dash-rest--desktop-dark.png"]);
    expect(readFileSync(join(issueShotsDir(r, id), shots[0]!), "utf8")).toBe("png");
  });

  test("drops a screenshot that is no longer this issue's evidence", async () => {
    const r = tmpProject("lookout-issues-");
    writeShot(r, "web/app/dash/rest--desktop-dark.png");
    const b = backlogOf([finding()]);
    await saveBacklog(r, b);
    const id = Object.keys(b.issues)[0]!;

    writeFileSync(join(issueShotsDir(r, id), "stale.png"), "old");
    await saveBacklog(r, b);
    expect(readdirSync(issueShotsDir(r, id))).toEqual(["web-app-dash-rest--desktop-dark.png"]);
  });

  test("the record is a projection: deleting it costs nothing", async () => {
    const r = tmpProject("lookout-issues-");
    const b = backlogOf([finding()]);
    await saveBacklog(r, b);
    const id = Object.keys(b.issues)[0]!;
    const doc = JSON.parse(readFileSync(join(issueDir(r, id), "issue.json"), "utf8")) as {
      generated: string;
    };
    expect(doc.generated).toContain("Safe to delete");
  });

  test("every issue on the board carries its number and its folder", async () => {
    const r = tmpProject("lookout-issues-");
    const b = backlogOf([finding(), finding({ fingerprint: "z", category: "spacing", attribute: "gap" })]);
    await saveBacklog(r, b);
    const issues = issuesOf(b);
    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      expect(isIssueId(issue.id)).toBe(true);
      expect(existsSync(issueDir(r, issue.id))).toBe(true);
      expect(issue.key).not.toBe(issue.id);
    }
  });
});

describe("`backlog check` guards the registry", () => {
  const clean = { mdOnDisk: null, latestReport: null };

  test("a finding whose root cause has no id is a problem, not a shrug", () => {
    const b = backlogOf([finding()]);
    const problems = checkBacklog(b, clean);
    expect(problems.map((p) => p.kind)).toContain("issue-missing");
    reconcileIssues(b, "t");
    expect(checkBacklog(b, clean).map((p) => p.kind)).not.toContain("issue-missing");
  });

  test("an id that is not six digits, or does not match its key, is caught", () => {
    const b = backlogOf([finding()]);
    reconcileIssues(b, "t");
    const id = Object.keys(b.issues)[0]!;
    b.issues.malformed = { id: "42", key: "app--spacing--gap", createdAt: "t" };
    expect(checkBacklog(b, clean).some((p) => p.message.includes("not six digits"))).toBe(true);

    delete b.issues.malformed;
    b.issues[id] = { ...b.issues[id]!, id: "999999" };
    expect(checkBacklog(b, clean).some((p) => p.message.includes("!= id"))).toBe(true);
  });

  test("two issues claiming one root cause is caught", () => {
    const b = backlogOf([finding()]);
    reconcileIssues(b, "t");
    const key = Object.values(b.issues)[0]!.key;
    b.issues["222222"] = { id: "222222", key, createdAt: "t" };
    expect(checkBacklog(b, clean).some((p) => p.message.includes("two issues claim"))).toBe(true);
  });
});
