import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fingerprintOf } from "../src/backlog/fingerprint.js";
import { routeToken } from "../src/capture/route-identity.js";
import {
  loadReport,
  mergeRun,
  shotId,
  shotRelPath,
  writeShotAria,
  writeShotFile,
  writeShotSidecar,
} from "../src/capture/store.js";
import { evidenceDir, lookoutDir } from "../src/config.js";
import { validateConfig } from "../src/config.js";
import type { Backlog, BacklogFinding } from "../src/backlog/lib.js";
import { loadBacklog } from "../src/verbs/backlog.js";
import type { CaptureReport, ResolvedConfig, ShotRecord } from "../src/types.js";

const axes = {
  target: "app",
  state: "rest",
  platform: "web" as const,
  formFactor: "desktop" as const,
  scheme: "light" as const,
};

function project(routes: string[]): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), "lookout-route-id-"));
  const resolved = {
    config: validateConfig({ targets: [{ name: "app", url: "http://localhost:1", routes }] }, "test"),
    configPath: join(dir, "lookout.config.ts"),
    projectDir: dir,
    project: "app",
  };
  mkdirSync(evidenceDir(resolved), { recursive: true });
  return resolved;
}

function shot(route: string, id: string, path: string): ShotRecord {
  return {
    ...axes,
    id,
    route,
    routeName: route,
    path,
    hash: `hash-${route}`,
    bytes: 1,
    width: 1,
    height: 1,
    animated: false,
    capturedAt: "2026-01-01T00:00:00.000Z",
    runId: "web-20260101-000000",
    deterministicFindings: [],
  };
}

function report(shots: ShotRecord[]): CaptureReport {
  return {
    version: 1,
    project: "app",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runs: [],
    shots,
  };
}

describe("canonical route identity", () => {
  test("preserves safe routes and separates every formerly colliding pair", () => {
    expect(routeToken("/settings")).toBe("settings");
    expect(routeToken("/")).toBe("root");
    const pairs = [
      ["/settings/profile", "/settings-profile"],
      ["/", "/root"],
      ["/Settings", "/settings"],
      ["/café", "/caf-"],
      ["/a.b", "/a-b"],
    ];
    for (const [a, b] of pairs) {
      expect(routeToken(a!)).not.toBe(routeToken(b!));
      expect(shotId({ ...axes, route: a! })).not.toBe(shotId({ ...axes, route: b! }));
      expect(shotRelPath({ ...axes, route: a! })).not.toBe(shotRelPath({ ...axes, route: b! }));
    }
    expect(routeToken("/x/".repeat(1_000))).toMatch(/^_route-[a-f0-9]{64}$/);
    expect(routeToken("/x/".repeat(1_000)).length).toBe(71);
    expect(routeToken(`/${"a".repeat(300)}`)).toMatch(/^_route-[a-f0-9]{64}$/);
  });

  test("keeps paths bounded and inside the target directory", () => {
    for (const route of ["/../secret", "/a/b?x=1", "/😀", "/UPPER"]) {
      const path = shotRelPath({ ...axes, route });
      expect(path).toMatch(/^web\/app\/(?:root|_route-[a-f0-9]{64}|[a-z0-9-]+)\//);
      expect(path).not.toContain("..");
    }
  });

  test("fingerprints distinguish lossy routes while safe fingerprints stay stable", () => {
    const finding = (route: string) => fingerprintOf({
      ...axes,
      route,
      category: "layout-overflow",
      attribute: "edge",
    });
    expect(finding("/settings")).toBe("app.settings.rest.desktop.light.layout-overflow.edge");
    expect(finding("/settings/profile")).not.toBe(finding("/settings-profile"));
    expect(finding("/")).not.toBe(finding("/root"));
  });

  test("stores formerly colliding pixels and sidecars as separate files", async () => {
    const resolved = project(["/settings/profile", "/settings-profile"]);
    const nested = { ...axes, route: "/settings/profile" };
    const dashed = { ...axes, route: "/settings-profile" };
    const [nestedPng, dashedPng] = await Promise.all([
      writeShotFile(resolved, nested, Buffer.from("nested")),
      writeShotFile(resolved, dashed, Buffer.from("dashed")),
    ]);
    const [nestedProvenance, dashedProvenance, nestedAria, dashedAria] = await Promise.all([
      writeShotSidecar(resolved, nested, { route: nested.route }),
      writeShotSidecar(resolved, dashed, { route: dashed.route }),
      writeShotAria(resolved, nested, { route: nested.route }),
      writeShotAria(resolved, dashed, { route: dashed.route }),
    ]);
    expect(nestedPng.rel).not.toBe(dashedPng.rel);
    expect(nestedProvenance.rel).not.toBe(dashedProvenance.rel);
    expect(nestedAria.rel).not.toBe(dashedAria.rel);
    expect(readFileSync(nestedPng.abs, "utf8")).toBe("nested");
    expect(readFileSync(dashedPng.abs, "utf8")).toBe("dashed");
  });

  test("mergeRun retains both formerly colliding routes as separate report rows", async () => {
    const resolved = project(["/settings/profile", "/settings-profile"]);
    const nestedAxes = { ...axes, route: "/settings/profile" };
    const dashedAxes = { ...axes, route: "/settings-profile" };
    const shots = [
      shot(nestedAxes.route, shotId(nestedAxes), shotRelPath(nestedAxes)),
      shot(dashedAxes.route, shotId(dashedAxes), shotRelPath(dashedAxes)),
    ];
    const run = {
      id: "web-20260101-000000",
      kind: "web" as const,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      flags: {},
      failures: [],
      skips: [],
    };
    const result = await mergeRun(resolved, run, shots);
    expect(result.report.shots).toHaveLength(2);
    expect(new Set(result.report.shots.map((entry) => entry.id)).size).toBe(2);
    expect(new Set(result.report.shots.map((entry) => entry.path)).size).toBe(2);
  });

  test("rejects exact route duplicates after leading-slash normalization", () => {
    expect(() =>
      validateConfig(
        { targets: [{ name: "app", url: "http://localhost:1", routes: ["settings", "/settings"] }] },
        "test",
      ),
    ).toThrow(/duplicates routes\[0\].*\/settings/);
    expect(() =>
      validateConfig(
        { targets: [{ name: "app", url: "http://localhost:1", routes: ["/settings/profile", "/settings-profile"] }] },
        "test",
      ),
    ).not.toThrow();
  });
});

describe("route identity migration", () => {
  test("moves an unambiguous legacy shot and both sidecars", async () => {
    const resolved = project(["/settings/profile"]);
    const oldPath = "web/app/settings-profile/rest--desktop-light.png";
    const oldId = "web/app/settings-profile/rest/desktop/light";
    const record = shot("/settings/profile", oldId, oldPath);
    record.provenance = `${oldPath}.provenance.json`;
    record.aria = `${oldPath}.aria.json`;
    writeFileSync(join(evidenceDir(resolved), "capture-report.json"), JSON.stringify(report([record])));
    mkdirSync(join(evidenceDir(resolved), "web/app/settings-profile"), { recursive: true });
    for (const suffix of ["", ".provenance.json", ".aria.json"]) {
      writeFileSync(join(evidenceDir(resolved), `${oldPath}${suffix}`), suffix || "png");
    }

    const migrated = await loadReport(resolved);
    const next = migrated!.shots[0]!;
    expect(next.id).toBe(shotId({ ...axes, route: "/settings/profile" }));
    expect(next.path).toBe(shotRelPath({ ...axes, route: "/settings/profile" }));
    expect(existsSync(join(evidenceDir(resolved), next.path))).toBe(true);
    expect(existsSync(join(evidenceDir(resolved), next.provenance!))).toBe(true);
    expect(existsSync(join(evidenceDir(resolved), next.aria!))).toBe(true);
    expect(existsSync(join(evidenceDir(resolved), oldPath))).toBe(false);
    expect(migrated!.routeIdentity).toBe(2);
  });

  test("a report-referenced legacy source replaces a stale canonical destination", async () => {
    const resolved = project(["/Settings"]);
    const oldPath = "web/app/settings/rest--desktop-light.png";
    const oldId = "web/app/settings/rest/desktop/light";
    const nextPath = shotRelPath({ ...axes, route: "/Settings" });
    writeFileSync(
      join(evidenceDir(resolved), "capture-report.json"),
      JSON.stringify(report([shot("/Settings", oldId, oldPath)])),
    );
    mkdirSync(join(evidenceDir(resolved), "web/app/settings"), { recursive: true });
    mkdirSync(join(evidenceDir(resolved), join(nextPath, "..")), { recursive: true });
    writeFileSync(join(evidenceDir(resolved), oldPath), "report pixels");
    writeFileSync(join(evidenceDir(resolved), nextPath), "stale destination");
    await loadReport(resolved);
    expect(readFileSync(join(evidenceDir(resolved), nextPath), "utf8")).toBe("report pixels");
    expect(existsSync(join(evidenceDir(resolved), oldPath))).toBe(false);
  });

  test("drops all legacy pixels in an ambiguous bucket and allows fresh canonical records", async () => {
    const resolved = project(["/settings/profile", "/settings-profile"]);
    const oldPath = "web/app/settings-profile/rest--desktop-light.png";
    const oldId = "web/app/settings-profile/rest/desktop/light";
    writeFileSync(join(evidenceDir(resolved), "capture-report.json"), JSON.stringify(report([
      shot("/settings-profile", oldId, oldPath),
    ])));
    mkdirSync(join(evidenceDir(resolved), "web/app/settings-profile"), { recursive: true });
    writeFileSync(join(evidenceDir(resolved), oldPath), "unknown pixels");

    const migrated = await loadReport(resolved);
    expect(migrated!.shots).toEqual([]);
    expect(existsSync(join(evidenceDir(resolved), oldPath))).toBe(false);

    const fresh = report([shot("/settings-profile", oldId, oldPath)]);
    fresh.routeIdentity = 2;
    writeFileSync(join(evidenceDir(resolved), "capture-report.json"), JSON.stringify(fresh));
    expect((await loadReport(resolved))!.shots).toHaveLength(1);
  });

  test("merge migration preserves a safe route file captured before the old report is read", async () => {
    const resolved = project(["/settings/profile", "/settings-profile"]);
    const safeAxes = { ...axes, route: "/settings-profile" };
    const oldPath = shotRelPath(safeAxes);
    const oldId = shotId(safeAxes);
    writeFileSync(
      join(evidenceDir(resolved), "capture-report.json"),
      JSON.stringify(report([shot("/settings/profile", oldId, oldPath)])),
    );
    mkdirSync(join(evidenceDir(resolved), "web/app/settings-profile"), { recursive: true });
    writeFileSync(join(evidenceDir(resolved), oldPath), "fresh safe pixels");
    const fresh = shot("/settings-profile", oldId, oldPath);
    const run = {
      id: "web-20260102-000000",
      kind: "web" as const,
      startedAt: "2026-01-02T00:00:00.000Z",
      finishedAt: "2026-01-02T00:00:01.000Z",
      flags: {},
      failures: [],
      skips: [],
    };
    const merged = await mergeRun(resolved, run, [fresh]);
    expect(merged.report.shots.map((entry) => entry.route)).toEqual(["/settings-profile"]);
    expect(readFileSync(join(evidenceDir(resolved), oldPath), "utf8")).toBe("fresh safe pixels");
  });

  test("rekeys backlog history and removes evidence whose legacy pixels were ambiguous", async () => {
    const resolved = project(["/settings/profile", "/settings-profile"]);
    writeFileSync(join(evidenceDir(resolved), "capture-report.json"), JSON.stringify(report([])));
    const legacyFingerprint = "app.settings-profile.rest.desktop.light.layout-overflow.edge";
    const finding: BacklogFinding = {
      fingerprint: legacyFingerprint,
      target: "app",
      route: "/settings/profile",
      state: "rest",
      platform: "web",
      formFactor: "desktop",
      scheme: "light",
      category: "layout-overflow",
      attribute: "edge",
      severity: "high",
      status: "blocked",
      reason: "upstream",
      title: "Edge clips",
      problem: "p",
      expected: "e",
      observed: "o",
      channel: "ai",
      confidence: "high",
      verified: true,
      evidence: [{ shotId: "web/app/settings-profile/rest/desktop/light", path: "web/app/settings-profile/rest--desktop-light.png", hash: "h", runId: "r" }],
      firstSeen: "r",
      lastSeen: "r",
      fixAttempts: 2,
      fixedIn: null,
    };
    const backlog: Backlog = {
      note: "n",
      project: "app",
      updatedAt: "t",
      findings: { [legacyFingerprint]: finding },
      issues: { "123456": { id: "123456", key: "app--layout-overflow--edge", createdAt: "t" } },
    };
    mkdirSync(lookoutDir(resolved), { recursive: true });
    writeFileSync(join(lookoutDir(resolved), "backlog.json"), JSON.stringify(backlog));

    const migrated = await loadBacklog(resolved);
    const record = Object.values(migrated.findings)[0]!;
    expect(record.fingerprint).not.toBe(legacyFingerprint);
    expect(record.status).toBe("blocked");
    expect(record.reason).toBe("upstream");
    expect(record.fixAttempts).toBe(2);
    expect(record.evidence).toEqual([]);
    expect(migrated.routeIdentity).toBe(2);
    expect(JSON.parse(readFileSync(join(lookoutDir(resolved), "backlog.json"), "utf8")).routeIdentity).toBe(2);
  });

  test("translates durable frame, baseline, attempt, and regression shot references", async () => {
    const resolved = project(["/Settings"]);
    const oldId = "web/app/settings/rest/desktop/light";
    const oldPath = "web/app/settings/rest--desktop-light.png";
    writeFileSync(
      join(evidenceDir(resolved), "capture-report.json"),
      JSON.stringify(report([shot("/Settings", oldId, oldPath)])),
    );
    mkdirSync(join(evidenceDir(resolved), "web/app/settings"), { recursive: true });
    writeFileSync(join(evidenceDir(resolved), oldPath), "pixels");

    const legacyFingerprint = "app.settings.rest.desktop.light.a11y.axe-button-name";
    const finding: BacklogFinding = {
      fingerprint: legacyFingerprint,
      target: "app",
      route: "/Settings",
      state: "rest",
      platform: "web",
      formFactor: "desktop",
      scheme: "light",
      category: "a11y",
      attribute: "axe-button-name",
      severity: "high",
      status: "open",
      reason: null,
      title: "Button needs a name",
      problem: "p",
      expected: "e",
      observed: "o",
      channel: "deterministic",
      confidence: "high",
      verified: true,
      evidence: [],
      firstSeen: "r",
      lastSeen: "r",
      fixAttempts: 1,
      fixedIn: null,
    };
    const backlog: Backlog = {
      note: "n",
      project: "app",
      updatedAt: "t",
      findings: { [legacyFingerprint]: finding },
      issues: {
        "123456": {
          id: "123456",
          key: "app--settings--a11y",
          createdAt: "t",
          acceptance: [{
            id: "criterion",
            text: "The button has a name.",
            source: "derived",
            from: legacyFingerprint,
            verdict: "met",
            evidence: [oldId],
          }],
        },
      },
    };
    mkdirSync(join(lookoutDir(resolved), "issues", "123456"), { recursive: true });
    writeFileSync(join(lookoutDir(resolved), "backlog.json"), JSON.stringify(backlog));
    writeFileSync(join(lookoutDir(resolved), "issues", "123456", "frames.json"), JSON.stringify({
      schema: 2,
      before: [{ path: "img/pre/old.png", route: "/Settings", formFactor: "desktop", scheme: "light", at: "t", shotId: oldId, hash: "h" }],
      after: [],
    }));
    writeFileSync(join(lookoutDir(resolved), "issues", "123456", "state.json"), JSON.stringify({
      id: "123456",
      baseline: { runId: "r", capturedAt: "t", hashes: { [oldId]: "h" } },
      attempts: [{ n: 1, dispatchedAt: "t", moved: [{ shotId: oldId, said: "moved" }], stillOpen: [{ title: "t", shotId: oldId, observed: "o" }] }],
    }));
    mkdirSync(join(lookoutDir(resolved), "regression"), { recursive: true });
    writeFileSync(join(lookoutDir(resolved), "regression", "manifest.json"), JSON.stringify({
      note: "n",
      frozenAt: "t",
      cases: [{ shotId: oldId, file: "old.png", target: "app", route: "/Settings", routeName: "/Settings", state: "rest", formFactor: "desktop", scheme: "light", platform: "web", width: 1, height: 1, mustNotFile: [], mustFile: [] }],
    }));

    const migrated = await loadBacklog(resolved);
    const nextId = shotId({ ...axes, route: "/Settings" });
    expect(Object.values(migrated.findings)[0]!.evidence).toEqual([]);
    expect(migrated.issues["123456"]!.key).toContain(routeToken("/Settings"));
    expect(migrated.issues["123456"]!.priorKeys).toContain("app--settings--a11y");
    expect(migrated.issues["123456"]!.acceptance![0]!.from).toBe(
      Object.values(migrated.findings)[0]!.fingerprint,
    );
    expect(migrated.issues["123456"]!.acceptance![0]!.evidence).toEqual([nextId]);
    const frames = JSON.parse(readFileSync(join(lookoutDir(resolved), "issues", "123456", "frames.json"), "utf8"));
    const state = JSON.parse(readFileSync(join(lookoutDir(resolved), "issues", "123456", "state.json"), "utf8"));
    const regression = JSON.parse(readFileSync(join(lookoutDir(resolved), "regression", "manifest.json"), "utf8"));
    expect(frames.before[0].shotId).toBe(nextId);
    expect(Object.keys(state.baseline.hashes)).toEqual([nextId]);
    expect(state.attempts[0].moved[0].shotId).toBe(nextId);
    expect(state.attempts[0].stillOpen[0].shotId).toBe(nextId);
    expect(regression.cases[0].shotId).toBe(nextId);
  });

  test("a split accessibility locus retains its original id for one successor", async () => {
    const resolved = project(["/settings/profile", "/settings-profile"]);
    writeFileSync(join(evidenceDir(resolved), "capture-report.json"), JSON.stringify(report([])));
    const base = (route: string, attribute: string): BacklogFinding => ({
      fingerprint: `app.settings-profile.rest.desktop.light.a11y.${attribute}`,
      target: "app",
      route,
      state: "rest",
      platform: "web",
      formFactor: "desktop",
      scheme: "light",
      category: "a11y",
      attribute,
      severity: "high",
      status: "open",
      reason: null,
      title: attribute,
      problem: "p",
      expected: "e",
      observed: "o",
      channel: "deterministic",
      confidence: "high",
      verified: true,
      evidence: [],
      firstSeen: "r",
      lastSeen: "r",
      fixAttempts: 0,
      fixedIn: null,
    });
    const backlog: Backlog = {
      note: "n",
      project: "app",
      updatedAt: "t",
      findings: {
        first: base("/settings/profile", "axe-name"),
        second: base("/settings-profile", "axe-role"),
      },
      issues: {
        "123456": {
          id: "123456",
          key: "app--settings-profile--a11y",
          createdAt: "t",
          byDesign: { reason: "accepted legacy behavior", at: "t" },
        },
      },
    };
    writeFileSync(join(lookoutDir(resolved), "backlog.json"), JSON.stringify(backlog));
    const migrated = await loadBacklog(resolved);
    const keys = Object.values(migrated.issues).map((issue) => issue.key).sort();
    expect(keys).toHaveLength(2);
    expect(migrated.issues["123456"]!.key).toBe(keys[0]!);
    expect(migrated.issues["123456"]!.priorKeys).toContain("app--settings-profile--a11y");
    expect(migrated.issues["123456"]!.byDesign?.reason).toBe("accepted legacy behavior");
    const successor = Object.values(migrated.issues).find((issue) => issue.id !== "123456")!;
    expect(successor.byDesign).toBeUndefined();
  });

  test("migrates shell evidence photographed on a secondary seen route without a report", async () => {
    const resolved = project(["/dashboard"]);
    const legacySettingsId = "web/app/settings/rest/desktop/light";
    const legacySettingsPath = "web/app/settings/rest--desktop-light.png";
    const fingerprint = "app.@shell-header.rest.desktop.light.layout-overflow.edge";
    const finding: BacklogFinding = {
      fingerprint,
      target: "app",
      route: "/dashboard",
      seenRoutes: ["/dashboard", "/Settings"],
      state: "rest",
      platform: "web",
      formFactor: "desktop",
      scheme: "light",
      region: "shell-header",
      category: "layout-overflow",
      attribute: "edge",
      severity: "high",
      status: "open",
      reason: null,
      title: "Header clips",
      problem: "p",
      expected: "e",
      observed: "o",
      channel: "ai",
      confidence: "high",
      verified: true,
      evidence: [{ shotId: legacySettingsId, path: legacySettingsPath, hash: "h", runId: "r" }],
      firstSeen: "r",
      lastSeen: "r",
      fixAttempts: 0,
      fixedIn: null,
    };
    const backlog: Backlog = {
      note: "n",
      project: "app",
      updatedAt: "t",
      findings: { [fingerprint]: finding },
      issues: { "123456": { id: "123456", key: "app--layout-overflow--edge", createdAt: "t" } },
    };
    writeFileSync(join(lookoutDir(resolved), "backlog.json"), JSON.stringify(backlog));
    const migrated = await loadBacklog(resolved);
    const evidence = migrated.findings[fingerprint]!.evidence[0]!;
    const settingsAxes = { ...axes, route: "/Settings" };
    expect(evidence.shotId).toBe(shotId(settingsAxes));
    expect(evidence.path).toBe(shotRelPath(settingsAxes));
  });
});
