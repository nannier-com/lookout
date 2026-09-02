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
import { issueDir, issueImgDir } from "../src/issues/paths.js";
import { frameAbsPath, freezeFrames, loadFrames } from "../src/issues/frames.js";
import { evidenceDir } from "../src/config.js";
import { loadBacklog, saveBacklog } from "../src/verbs/backlog.js";
import { emptyBacklog, type Backlog, type BacklogFinding, type IssueRecord } from "../src/backlog/lib.js";
import { saveState } from "../src/fix/state.js";
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
  mkdirSync(join(r.projectDir, ".lookout"), { recursive: true });
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
  const p = join(evidenceDir(r), relPath);
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
    // Byte-exact listing rather than existsSync: on a case-insensitive
    // filesystem (the macOS default) existsSync("issue.json") is true when
    // only Issue.json exists, so it cannot pin the casing.
    expect(readdirSync(dir).sort()).toEqual(["Issue.json", "Issue.md", "frames.json", "img"]);

    const doc = JSON.parse(readFileSync(join(dir, "Issue.json"), "utf8")) as Record<string, unknown>;
    expect(doc.id).toBe(id);
    expect(doc.key).toBe("app--color-scheme--theme-not-switching");
    expect(doc.status).toBe("open");
    expect(doc.severity).toBe("high");

    // The pixels come with it: a dossier that points into a gitignored
    // directory is a dossier full of dead links the first time it is cleaned.
    const shots = readdirSync(join(issueImgDir(r, id), "pre"));
    expect(shots).toEqual(["web-app-dash-rest--desktop-dark.png"]);
    expect(readFileSync(join(issueImgDir(r, id), "pre", shots[0]!), "utf8")).toBe("png");
  });

  test("drops a screenshot that is no longer this issue's evidence", async () => {
    const r = tmpProject("lookout-issues-");
    writeShot(r, "web/app/dash/rest--desktop-dark.png");
    const b = backlogOf([finding()]);
    await saveBacklog(r, b);
    const id = Object.keys(b.issues)[0]!;

    writeFileSync(join(issueImgDir(r, id), "pre", "stale.png"), "old");
    await saveBacklog(r, b);
    expect(readdirSync(join(issueImgDir(r, id), "pre"))).toEqual(["web-app-dash-rest--desktop-dark.png"]);
  });

  // A save is the last moment the store still holds the pixels the finding was
  // judged from, so it is where the defect is frozen. Before this, an issue
  // nobody verified had its only copy overwritten by the next capture.
  test("a save freezes the defect, and img/pre is a copy of what it froze", async () => {
    const r = tmpProject("lookout-issues-");
    writeShot(r, "web/app/dash/rest--desktop-dark.png", "the defect");
    const b = backlogOf([finding()]);
    await saveBacklog(r, b);
    const id = Object.keys(b.issues)[0]!;

    const frames = await loadFrames(r, id);
    expect(frames.before).toHaveLength(1);
    expect(readFileSync(frameAbsPath(r, id, frames.before[0]!), "utf8")).toBe("the defect");
    expect(readFileSync(join(issueImgDir(r, id), "pre", "web-app-dash-rest--desktop-dark.png"), "utf8"))
      .toBe("the defect");
  });

  test("re-capturing the view does not change what the issue was filed against", async () => {
    const r = tmpProject("lookout-issues-");
    writeShot(r, "web/app/dash/rest--desktop-dark.png", "the defect");
    const b = backlogOf([finding()]);
    await saveBacklog(r, b);
    const id = Object.keys(b.issues)[0]!;

    // What a later `check` does: same view, same path, new pixels.
    writeShot(r, "web/app/dash/rest--desktop-dark.png", "the fixed screen");
    await saveBacklog(r, b);

    expect(readFileSync(join(issueImgDir(r, id), "pre", "web-app-dash-rest--desktop-dark.png"), "utf8"))
      .toBe("the defect");
  });

  test("a ruled fix puts the other side of the comparison in img/post", async () => {
    const r = tmpProject("lookout-issues-");
    writeShot(r, "web/app/dash/rest--desktop-dark.png", "the defect");
    const b = backlogOf([finding()]);
    await saveBacklog(r, b);
    const id = Object.keys(b.issues)[0]!;

    writeShot(r, "web/app/dash/rest--desktop-dark.png", "the fixed screen");
    await freezeFrames(r, issuesOf(b).find((c) => c.id === id)!, "after");
    await saveBacklog(r, b);

    const img = issueImgDir(r, id);
    expect(readdirSync(join(img, "post"))).toEqual(["web-app-dash-rest--desktop-dark.png"]);
    expect(readFileSync(join(img, "post", "web-app-dash-rest--desktop-dark.png"), "utf8"))
      .toBe("the fixed screen");
    expect(readFileSync(join(img, "pre", "web-app-dash-rest--desktop-dark.png"), "utf8"))
      .toBe("the defect");
  });

  test("the record is a projection: deleting it costs nothing", async () => {
    const r = tmpProject("lookout-issues-");
    const b = backlogOf([finding()]);
    await saveBacklog(r, b);
    const id = Object.keys(b.issues)[0]!;
    const doc = JSON.parse(readFileSync(join(issueDir(r, id), "Issue.json"), "utf8")) as {
      generated: string;
    };
    expect(doc.generated).toContain("Safe to delete");
  });

  // `backlog check` is where the guarantee is checked rather than assumed: an
  // issue with a screenshot behind it and no frozen frame has lost its only
  // picture of the defect, and nothing else on disk says so.
  test("backlog check reports an issue with no pre-fix screenshot", () => {
    const b = backlogOf([finding()]);
    reconcileIssues(b, "t");
    const id = Object.keys(b.issues)[0]!;

    const missing = checkBacklog(b, { mdOnDisk: null, latestReport: null, framesByIssue: { [id]: 0 } });
    expect(missing.filter((p) => p.kind === "frames-missing")).toHaveLength(1);
    expect(missing.find((p) => p.kind === "frames-missing")!.message).toContain(id);

    const frozen = checkBacklog(b, { mdOnDisk: null, latestReport: null, framesByIssue: { [id]: 1 } });
    expect(frozen.filter((p) => p.kind === "frames-missing")).toEqual([]);
  });

  test("a code-channel issue is never asked for a screenshot it cannot have", () => {
    const b = backlogOf([
      finding({ channel: "code", platform: undefined, formFactor: undefined, scheme: undefined } as Partial<BacklogFinding>),
    ]);
    reconcileIssues(b, "t");
    const id = Object.keys(b.issues)[0]!;

    const problems = checkBacklog(b, { mdOnDisk: null, latestReport: null, framesByIssue: { [id]: 0 } });
    expect(problems.filter((p) => p.kind === "frames-missing")).toEqual([]);
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

describe("a legacy folder migrates on save", () => {
  /** Build the pre-rename layout by hand: issue.json, ISSUE.md, shots/. */
  function seedLegacy(r: ResolvedConfig, id: string, files: Record<string, string>): string {
    const dir = issueDir(r, id);
    mkdirSync(join(dir, "shots"), { recursive: true });
    for (const [name, bytes] of Object.entries(files)) {
      writeFileSync(join(dir, name), bytes);
    }
    return dir;
  }

  test("renames the record, the document and the shots folder", async () => {
    const r = tmpProject("lookout-issues-");
    writeShot(r, "web/app/dash/rest--desktop-dark.png");
    const b = backlogOf([finding()]);
    reconcileIssues(b, "t");
    const id = Object.keys(b.issues)[0]!;
    const dir = seedLegacy(r, id, {
      "issue.json": "{}",
      "ISSUE.md": "old",
      "shots/web-app-dash-rest--desktop-dark.png": "old-pixels",
      "shots/stale.png": "old",
    });

    await saveBacklog(r, b);

    // Byte-exact listing, never existsSync: on a case-insensitive filesystem
    // (the macOS default) existsSync("issue.json") is true when only
    // Issue.json exists, so it cannot tell a migrated folder from a stale one.
    expect(readdirSync(dir).sort()).toEqual(["Issue.json", "Issue.md", "frames.json", "img"]);
    const doc = JSON.parse(readFileSync(join(dir, "Issue.json"), "utf8")) as { id: string };
    expect(doc.id).toBe(id);
    // The wanted shot was refreshed from the evidence store; the stale one
    // was moved across and then pruned like any other orphan.
    expect(readdirSync(join(issueImgDir(r, id), "pre"))).toEqual(["web-app-dash-rest--desktop-dark.png"]);
    expect(readFileSync(join(issueImgDir(r, id), "pre", "web-app-dash-rest--desktop-dark.png"), "utf8")).toBe("png");
  });

  test("moved pixels survive an evidence clean", async () => {
    const r = tmpProject("lookout-issues-");
    // No evidence store on disk: it is gitignored and routinely cleaned. The
    // folder's copy is the only one left, so migration must move it, not
    // delete and re-copy it.
    const b = backlogOf([finding()]);
    reconcileIssues(b, "t");
    const id = Object.keys(b.issues)[0]!;
    seedLegacy(r, id, {
      "issue.json": "{}",
      "ISSUE.md": "old",
      "shots/web-app-dash-rest--desktop-dark.png": "old-pixels",
    });

    await saveBacklog(r, b);

    expect(readdirSync(join(issueImgDir(r, id), "pre"))).toEqual(["web-app-dash-rest--desktop-dark.png"]);
    expect(
      readFileSync(join(issueImgDir(r, id), "pre", "web-app-dash-rest--desktop-dark.png"), "utf8"),
    ).toBe("old-pixels");
  });

  test("is idempotent: a second save changes nothing", async () => {
    const r = tmpProject("lookout-issues-");
    writeShot(r, "web/app/dash/rest--desktop-dark.png");
    const b = backlogOf([finding()]);
    reconcileIssues(b, "t");
    const id = Object.keys(b.issues)[0]!;
    const dir = seedLegacy(r, id, {
      "issue.json": "{}",
      "shots/web-app-dash-rest--desktop-dark.png": "old-pixels",
    });

    await saveBacklog(r, b);
    const first = readdirSync(dir).sort();
    await saveBacklog(r, b);

    // The failure this pins down is removing the legacy name AFTER the new
    // one is written: on a case-insensitive filesystem "issue.json" resolves
    // to Issue.json and deletes it. Linux CI is case-sensitive and cannot
    // reproduce that, so the local macOS run of this suite is the real gate.
    expect(readdirSync(dir).sort()).toEqual(first);
    expect(first).toEqual(["Issue.json", "Issue.md", "frames.json", "img"]);
    const doc = JSON.parse(readFileSync(join(dir, "Issue.json"), "utf8")) as { id: string };
    expect(doc.id).toBe(id);
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

describe("Issue.json is the document's twin", () => {
  test("it carries what the markdown states, in the shape it had before it was a sentence", async () => {
    const r = tmpProject("lookout-issues-");
    writeShot(r, "web/app/dash/rest--desktop-dark.png");
    const b = backlogOf([finding()]);
    await saveBacklog(r, b);
    const id = Object.keys(b.issues)[0]!;
    b.issues[id]!.placement = {
      kind: "kit-component", kit: "@acme/kit", primaryPath: "/abs/Button.tsx", symbol: "Button", reason: "made once",
      otherCallers: 3, blastRadius: "every button", alsoRead: [], notes: "", kitEditable: true, at: "t",
    } as IssueRecord["placement"];
    await saveState(r, { id, attempts: [{ n: 1, dispatchedAt: "2026-08-29T10:00:00.000Z", reported: { commit: "deadbee" }, verdict: "still-open", judgeNote: "still there" }] });
    await saveBacklog(r, b);

    const doc = JSON.parse(readFileSync(join(issueDir(r, id), "Issue.json"), "utf8")) as Record<string, unknown>;
    // The members whole, with their evidence resolved to a path somebody can open.
    const members = doc.members as { fingerprint: string; problem: string; evidence: { absPath: string; path: string }[] }[];
    expect(members).toHaveLength(1);
    expect(members[0]!.evidence[0]!.absPath).toBe(join(evidenceDir(r), "web/app/dash/rest--desktop-dark.png"));
    expect(members[0]!.evidence[0]!.absPath.startsWith("/")).toBe(true);
    // The attempts as state.json keeps them, the placement, and the derivations the document prints.
    expect((doc.attempts as { n: number; judgeNote: string }[])[0]).toMatchObject({ n: 1, judgeNote: "still there" });
    expect((doc.placement as { kit: string }).kit).toBe("@acme/kit");
    expect((doc.scope as { routes: string[]; panel: string | null }).routes).toEqual(["/dash"]);
    expect(doc.siblings).toEqual([]);
    const artifacts = doc.artifacts as { name: string; path: string; exists: boolean }[];
    expect(artifacts.find((a) => a.name === "config")!.path).toBe(r.configPath ?? "");
    expect(artifacts.find((a) => a.name === "backlog")).toMatchObject({ exists: true });
    expect(artifacts.find((a) => a.name === "capture report")).toMatchObject({ exists: false });
    expect(doc.attribute).toBe("theme-not-switching");
    expect(doc.confidence).toBe("high");
    expect(doc.seenRoutes).toEqual(["/dash"]);
  });

  test("the folder still holds exactly the four things it always has", async () => {
    const r = tmpProject("lookout-issues-");
    writeShot(r, "web/app/dash/rest--desktop-dark.png");
    const b = backlogOf([finding()]);
    await saveBacklog(r, b);
    const id = Object.keys(b.issues)[0]!;
    expect(readdirSync(issueDir(r, id)).sort()).toEqual(["Issue.json", "Issue.md", "frames.json", "img"]);
  });
});
