// The evidence store writes each view back to the path it came from, so proving
// a defect gone destroys the picture of it. These pin the frames that are kept
// out of the way, and the rule that decides which frame wins.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBeforeFrames, freezeFrames, loadFrames, framesDir } from "../src/issues/frames.js";
import { evidenceDir } from "../src/config.js";
import { buildBoard } from "../src/report/board.js";
import type { FixCluster } from "../src/fix/cluster.js";
import type { BacklogFinding } from "../src/backlog/lib.js";
import type { ResolvedConfig } from "../src/types.js";

function project(): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), "lookout-frames-"));
  mkdirSync(join(dir, ".lookout"), { recursive: true });
  const r = {
    config: {} as ResolvedConfig["config"],
    configPath: join(dir, "lookout.config.ts"),
    projectDir: dir,
    project: "app",
  } as ResolvedConfig;
  mkdirSync(join(evidenceDir(r), "web", "app"), { recursive: true });
  return r;
}

/** A screenshot on disk, with content a test can tell apart from another one. */
function shotFile(r: ResolvedConfig, rel: string, body: string): void {
  writeFileSync(join(evidenceDir(r), rel), body);
}

function member(over: Partial<BacklogFinding> = {}): BacklogFinding {
  const formFactor = (over.formFactor ?? "desktop") as BacklogFinding["formFactor"];
  return {
    fingerprint: `app./settings.rest.${formFactor}.dark.spacing.rhythm`,
    target: "app",
    route: "/settings",
    state: "rest",
    platform: "web",
    formFactor,
    scheme: "dark",
    category: "spacing",
    attribute: "rhythm",
    severity: "medium",
    status: "open",
    reason: null,
    title: "Settings rows have no rhythm",
    problem: "p",
    expected: "e",
    observed: "o",
    channel: "ai",
    confidence: "high",
    verified: true,
    evidence: [
      {
        shotId: `web/app/settings/rest/${formFactor}/dark`,
        path: `web/app/settings--${formFactor}-dark.png`,
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

function cluster(members: BacklogFinding[], over: Partial<FixCluster> = {}): FixCluster {
  return {
    id: "246813",
    key: "app--spacing--rhythm",
    target: "app",
    category: "spacing",
    attribute: "rhythm",
    defects: [],
    severity: "medium",
    title: "Settings rows have no rhythm",
    problem: "p",
    expected: "e",
    observed: "o",
    routes: ["/settings"],
    fingerprints: members.map((m) => m.fingerprint),
    members,
    shotCount: members.length,
    findingCount: members.length,
    attemptsSpent: 0,
    verified: true,
    channel: "ai",
    ...over,
  } as FixCluster;
}

describe("freezing the frames either side of a fix", () => {
  test("copies the current evidence aside and records what each frame is of", async () => {
    const r = project();
    shotFile(r, "web/app/settings--desktop-dark.png", "the defect");
    const c = cluster([member()]);

    const frozen = await freezeFrames(r, c, "before");
    expect(frozen).toHaveLength(1);
    expect(frozen[0]!.path).toBe("fix-frames/246813/before/web-app-settings--desktop-dark.png");
    expect(frozen[0]!.route).toBe("/settings");
    expect(frozen[0]!.formFactor).toBe("desktop");

    // The copy is the pixels, not a reference to a file that is about to change.
    const copied = readFileSync(join(framesDir(r, "246813"), "before", "web-app-settings--desktop-dark.png"), "utf8");
    expect(copied).toBe("the defect");
    expect((await loadFrames(r, "246813")).before).toHaveLength(1);
  });

  test("the before frame is the defect as filed, not as the last attempt left it", async () => {
    const r = project();
    shotFile(r, "web/app/settings--desktop-dark.png", "the defect");
    const c = cluster([member()]);
    await freezeFrames(r, c, "before");

    // A second attempt: the store now holds whatever the first attempt produced.
    shotFile(r, "web/app/settings--desktop-dark.png", "a failed attempt");
    await freezeFrames(r, c, "before");

    const copied = readFileSync(join(framesDir(r, "246813"), "before", "web-app-settings--desktop-dark.png"), "utf8");
    expect(copied).toBe("the defect");
  });

  test("the after frame is whatever last passed, so it is rewritten", async () => {
    const r = project();
    shotFile(r, "web/app/settings--desktop-dark.png", "first pass");
    const c = cluster([member()]);
    await freezeFrames(r, c, "after");
    shotFile(r, "web/app/settings--desktop-dark.png", "later pass");
    await freezeFrames(r, c, "after");

    const copied = readFileSync(join(framesDir(r, "246813"), "after", "web-app-settings--desktop-dark.png"), "utf8");
    expect(copied).toBe("later pass");
  });

  test("freezes one frame per view, across every form factor the issue covers", async () => {
    const r = project();
    shotFile(r, "web/app/settings--desktop-dark.png", "desktop");
    shotFile(r, "web/app/settings--phone-dark.png", "phone");
    const c = cluster([member(), member({ formFactor: "phone" as BacklogFinding["formFactor"] })]);

    const frozen = await freezeFrames(r, c, "before");
    expect(frozen.map((f) => f.formFactor).sort()).toEqual(["desktop", "phone"]);
  });

  test("a code-channel issue has nothing to freeze and says so quietly", async () => {
    const r = project();
    const source = member({
      channel: "code",
      platform: undefined,
      formFactor: undefined,
      scheme: undefined,
      evidence: [],
    } as unknown as Partial<BacklogFinding>);
    const frozen = await freezeFrames(r, cluster([source], { channel: "code" }), "before");
    expect(frozen).toEqual([]);
    expect(await loadFrames(r, "246813")).toEqual({ schema: 1, before: [], after: [] });
  });

  test("a frame whose file has been cleaned out of the store is skipped, not invented", async () => {
    const r = project();
    // No file written at all: the evidence store has been cleaned.
    const frozen = await freezeFrames(r, cluster([member()]), "before");
    expect(frozen).toEqual([]);
  });
});

describe("the board carries both sides", () => {
  test("frozen frames reach the page as shots with servable paths", async () => {
    const r = project();
    shotFile(r, "web/app/settings--desktop-dark.png", "the defect");
    writeFileSync(
      join(r.projectDir, ".lookout", "backlog.json"),
      JSON.stringify({
        note: "",
        project: "app",
        updatedAt: new Date(0).toISOString(),
        findings: { [member().fingerprint]: member() },
      }),
    );
    // The id the backlog mints is not the fixture's, so freeze against it.
    const board0 = await buildBoard(r);
    const id = board0[0]!.id;
    await freezeFrames(r, cluster([member()], { id }), "before");
    shotFile(r, "web/app/settings--desktop-dark.png", "the fix");
    await freezeFrames(r, cluster([member()], { id }), "after");

    const entry = (await buildBoard(r))[0]!;
    expect(entry.before).toHaveLength(1);
    expect(entry.after).toHaveLength(1);
    // Evidence-relative, because that is what the page's own routes serve.
    expect(entry.before[0]!.path).toBe(`fix-frames/${id}/before/web-app-settings--desktop-dark.png`);
    expect(entry.after[0]!.absPath).toContain(join(evidenceDir(r), "fix-frames"));
  });
});

// The before frame used to be taken by `verify-fix` alone, so an issue nobody
// ever asked lookout to verify reached the board with no picture of its own
// defect, and the card fell back to a store the next capture had overwritten.
describe("every issue gets a picture of its own defect", () => {
  const preFile = (r: ResolvedConfig): string =>
    join(framesDir(r, "246813"), "before", "web-app-settings--desktop-dark.png");

  test("freezes the before on an issue nothing has tried to fix yet", async () => {
    const r = project();
    shotFile(r, "web/app/settings--desktop-dark.png", "the defect");

    const set = await ensureBeforeFrames(r, cluster([member()]));

    expect(set.before).toHaveLength(1);
    expect(readFileSync(preFile(r), "utf8")).toBe("the defect");
  });

  test("keeps the first freeze when the store has moved on", async () => {
    const r = project();
    shotFile(r, "web/app/settings--desktop-dark.png", "the defect");
    await ensureBeforeFrames(r, cluster([member()]));

    // Any later capture of the same view overwrites the store in place.
    shotFile(r, "web/app/settings--desktop-dark.png", "re-captured later");
    await ensureBeforeFrames(r, cluster([member()]));

    expect(readFileSync(preFile(r), "utf8")).toBe("the defect");
  });

  test("freezes a view the issue only gained later, and leaves the first alone", async () => {
    const r = project();
    shotFile(r, "web/app/settings--desktop-dark.png", "the defect on desktop");
    await ensureBeforeFrames(r, cluster([member()]));

    // The same defect turns up on the phone, so a member joins the cluster. Its
    // own frame is this view's filing moment, whatever the issue has spent.
    shotFile(r, "web/app/settings--phone-dark.png", "the defect on phone");
    shotFile(r, "web/app/settings--desktop-dark.png", "re-captured later");
    const set = await ensureBeforeFrames(
      r,
      cluster([member(), member({ formFactor: "phone" as BacklogFinding["formFactor"] })]),
    );

    expect(set.before.map((f) => f.formFactor).sort()).toEqual(["desktop", "phone"]);
    expect(readFileSync(preFile(r), "utf8")).toBe("the defect on desktop");
    expect(
      readFileSync(join(framesDir(r, "246813"), "before", "web-app-settings--phone-dark.png"), "utf8"),
    ).toBe("the defect on phone");
  });

  test("does not backfill an issue that has already spent an attempt", async () => {
    const r = project();
    // Something has claimed to change this screen since the finding was filed,
    // so the store holds pixels of unknown vintage. Filing them as "the defect"
    // would put a picture of somebody's fix under the wrong label.
    shotFile(r, "web/app/settings--desktop-dark.png", "somebody's first try");

    const set = await ensureBeforeFrames(
      r,
      cluster([member({ fixAttempts: 1 })], { attemptsSpent: 1 }),
    );

    expect(set.before).toEqual([]);
    expect(await loadFrames(r, "246813")).toEqual({ schema: 1, before: [], after: [] });
  });
});
