// What a ruling compares its fresh screenshots against, and why it is the
// issue's own record rather than the workspace: a check run between the edit
// and the ruling puts the fixed page in the workspace, and comparing the fixed
// page to itself read a real fix as no change.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { issueBaseline, loadIssueBaseline, rulingBaselineOf } from "../src/verify/baseline.js";
import { freezeFrames, loadFrames } from "../src/issues/frames.js";
import { evidenceDir } from "../src/config.js";
import { saveState } from "../src/fix/state.js";
import { issueDir } from "../src/issues/paths.js";
import { sha256 } from "../src/util.js";
import { tmpProject } from "./tmp-project.js";
import type { BacklogFinding } from "../src/backlog/lib.js";
import type { FixCluster } from "../src/fix/cluster.js";
import type { ShotRecord } from "../src/types.js";

const SHOT = "web/app/dash/rest/phone/dark";
const PNG = "web/app/dash/rest--phone-dark.png";

function finding(hash = "filed"): BacklogFinding {
  return {
    fingerprint: "app./dash.rest.phone.dark.layout-overflow.x",
    target: "app", route: "/dash", state: "rest", platform: "web", formFactor: "phone", scheme: "dark",
    category: "layout-overflow", attribute: "x", severity: "high", status: "open", reason: null,
    title: "t", problem: "p", expected: "e", observed: "o", channel: "ai", confidence: "high", verified: true,
    evidence: [{ shotId: SHOT, path: PNG, hash, runId: "r1" }],
    firstSeen: "r1", lastSeen: "r1", fixAttempts: 0, fixedIn: null,
  } as BacklogFinding;
}

const cluster = (members: BacklogFinding[]): FixCluster =>
  ({ id: "418203", members, fingerprints: members.map((m) => m.fingerprint) }) as unknown as FixCluster;

describe("the precedence, per shot", () => {
  test("the previous ruling's capture wins, then the frozen frame, then the workspace, then the evidence", () => {
    const b = issueBaseline({
      ruling: { runId: "v1", capturedAt: "t2", hashes: { [SHOT]: "ruled" } },
      frozen: [{ shotId: SHOT, hash: "frozen", at: "t1" }, { shotId: "web/app/x/rest/phone/dark", hash: "frozen-x", at: "t1" }],
      priorShots: [{ id: SHOT, hash: "workspace" }, { id: "web/app/y/rest/phone/dark", hash: "workspace-y" }],
      findings: [finding("evidence")],
    });
    expect(b.hashes.get(SHOT)).toBe("ruled");
    expect(b.hashes.get("web/app/x/rest/phone/dark")).toBe("frozen-x");
    expect(b.hashes.get("web/app/y/rest/phone/dark")).toBe("workspace-y");
    expect(b.described).toEqual({ kind: "ruling", runId: "v1", at: "t2" });
  });

  test("the trap: a check since the edit moved the workspace to the fixed page, and the frozen frame still says what was filed", () => {
    const fixed = "fixed-page";
    const b = issueBaseline({
      frozen: [{ shotId: SHOT, hash: "defect-as-filed", at: "t1" }],
      // The workspace and the re-sighted evidence both hold the fixed page now.
      priorShots: [{ id: SHOT, hash: fixed }],
      findings: [finding(fixed)],
    });
    expect(b.hashes.get(SHOT)).toBe("defect-as-filed");
    expect(b.hashes.get(SHOT) !== fixed).toBe(true);
    expect(b.described).toEqual({ kind: "frozen", at: "t1" });
  });

  test("with no record of its own, the workspace and the evidence as before", () => {
    const b = issueBaseline({ frozen: [], priorShots: [{ id: SHOT, hash: "workspace" }], findings: [finding("evidence")] });
    expect(b.hashes.get(SHOT)).toBe("workspace");
    expect(b.described).toEqual({ kind: "report" });
    expect(issueBaseline({ frozen: [], priorShots: [], findings: [finding("evidence")] }).hashes.get(SHOT)).toBe("evidence");
  });

  test("a frame without a shot id or hash contributes nothing here", () => {
    const b = issueBaseline({ frozen: [{ at: "t1" }], priorShots: [], findings: [finding("evidence")] });
    expect(b.hashes.get(SHOT)).toBe("evidence");
    expect(b.described.kind).toBe("report");
  });
});

describe("read off the issue's folder", () => {
  function withShot(): { r: ReturnType<typeof tmpProject>; bytes: Buffer } {
    const r = tmpProject("lookout-baseline-");
    const bytes = Buffer.from("the defect as filed");
    mkdirSync(join(evidenceDir(r), "web", "app", "dash"), { recursive: true });
    writeFileSync(join(evidenceDir(r), PNG), bytes);
    return { r, bytes };
  }

  test("freezing a frame records the shot it copies and the hash of its pixels", async () => {
    const { r } = withShot();
    await freezeFrames(r, cluster([finding("filed-hash")]), "before");
    const frames = await loadFrames(r, "418203");
    expect(frames.before[0]).toMatchObject({ shotId: SHOT, hash: "filed-hash" });
    const b = await loadIssueBaseline(r, cluster([finding("moved")]), [{ id: SHOT, hash: "moved" }], [finding("moved")]);
    expect(b.hashes.get(SHOT)).toBe("filed-hash");
    expect(b.described.kind).toBe("frozen");
  });

  test("a frame frozen before those were recorded is recovered from the file and the view", async () => {
    const { r, bytes } = withShot();
    const dir = join(issueDir(r, "418203"), "img", "pre");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "web-app-dash-rest--phone-dark.png"), bytes);
    writeFileSync(
      join(issueDir(r, "418203"), "frames.json"),
      JSON.stringify({ schema: 2, before: [{ path: "img/pre/web-app-dash-rest--phone-dark.png", route: "/dash", formFactor: "phone", scheme: "dark", at: "t1" }], after: [] }),
    );
    const b = await loadIssueBaseline(r, cluster([finding("moved")]), [], [finding("moved")]);
    expect(b.hashes.get(SHOT)).toBe(sha256(bytes));
    expect(b.described).toEqual({ kind: "frozen", at: "t1" });
  });

  test("once ruled, the ruling's capture outranks the frozen frame", async () => {
    const { r } = withShot();
    await freezeFrames(r, cluster([finding("filed-hash")]), "before");
    await saveState(r, { id: "418203", attempts: [], baseline: { runId: "v1", capturedAt: "t2", hashes: { [SHOT]: "after-attempt-1" } } });
    const b = await loadIssueBaseline(r, cluster([finding("x")]), [], []);
    expect(b.hashes.get(SHOT)).toBe("after-attempt-1");
    expect(b.described).toEqual({ kind: "ruling", runId: "v1", at: "t2" });
  });

  test("a ruling's capture becomes the next baseline, shot by shot", () => {
    const shots = new Map<string, ShotRecord>([
      [SHOT, { id: SHOT, hash: "a", runId: "web-1", capturedAt: "t" } as ShotRecord],
      ["s2", { id: "s2", hash: "b", runId: "web-1", capturedAt: "t" } as ShotRecord],
    ]);
    expect(rulingBaselineOf(shots)).toEqual({ runId: "web-1", capturedAt: "t", hashes: { [SHOT]: "a", s2: "b" } });
    expect(rulingBaselineOf(new Map())).toBeUndefined();
  });
});
