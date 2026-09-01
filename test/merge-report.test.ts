// The on-disk judge report reaches the merge from where `check` writes it: the
// capture workspace under the operator's home. The read and the write are in
// different files, so only a test holds them to the same path; when the
// workspace moved out of the judged project, the reader stayed behind and every
// merge-from-disk silently lost its AI findings.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceDir, lookoutDir } from "../src/config.js";
import { loadBacklog, mergeLatest } from "../src/verbs/backlog.js";
import { LookoutError, type ResolvedConfig } from "../src/types.js";

function project(): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), "lookout-mergerep-"));
  mkdirSync(join(dir, ".lookout"), { recursive: true });
  const r = {
    config: {} as ResolvedConfig["config"],
    configPath: join(dir, "lookout.config.ts"),
    projectDir: dir,
    project: "app",
  } as ResolvedConfig;
  mkdirSync(evidenceDir(r), { recursive: true });
  return r;
}

function writeCaptureReport(r: ResolvedConfig): void {
  writeFileSync(
    join(evidenceDir(r), "capture-report.json"),
    JSON.stringify({
      version: 1,
      project: "app",
      runs: [{ id: "r1", startedAt: new Date(0).toISOString() }],
      shots: [
        {
          id: "web/app/dash/rest/desktop/dark",
          runId: "r1",
          target: "app",
          route: "/dash",
          routeName: "dash",
          state: "rest",
          platform: "web",
          formFactor: "desktop",
          scheme: "dark",
          path: "web/app/dash/rest--desktop-dark.png",
          hash: "h1",
          animated: false,
          deterministicFindings: [],
        },
      ],
      failures: [],
    }),
  );
}

function judgeReport(): string {
  return JSON.stringify({
    runId: "check-1",
    findings: [
      {
        shotId: "web/app/dash/rest/desktop/dark",
        category: "color-scheme",
        attribute: "theme-not-applied",
        severity: "high",
        title: "Dark scheme renders light surfaces",
        problem: "p",
        expected: "e",
        observed: "o",
        confidence: "high",
        verified: true,
      },
    ],
  });
}

describe("the merge finds the judge report on disk", () => {
  test("in the capture workspace, where check writes it", async () => {
    const r = project();
    writeCaptureReport(r);
    writeFileSync(join(evidenceDir(r), "judge-report.json"), judgeReport());
    await mergeLatest(r, {});
    const b = await loadBacklog(r);
    const ai = Object.values(b.findings).filter((f) => f.channel === "ai");
    expect(ai).toHaveLength(1);
    expect(ai[0]!.title).toBe("Dark scheme renders light surfaces");
  });

  test("under the project's own .lookout/evidence, where an older lookout left it", async () => {
    const r = project();
    writeCaptureReport(r);
    const legacy = join(lookoutDir(r), "evidence");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "judge-report.json"), judgeReport());
    await mergeLatest(r, {});
    const b = await loadBacklog(r);
    expect(Object.values(b.findings).filter((f) => f.channel === "ai")).toHaveLength(1);
  });
});

// Every finding a merge files is stamped with the latest capture run. A report
// with an empty `runs` array therefore has nothing to stamp with, and the
// existing guard only asked whether the file was there at all: the read of
// `runs[length - 1]` came back undefined and the merge died on a TypeError.
// `lookout capture` always records a run, so the only reports that look like
// this are truncated or hand-authored ones, which is malformed input and gets
// the same LookoutError as every other malformed input here.
describe("a capture report with no runs recorded", () => {
  test("raises a LookoutError naming the problem, not a TypeError", async () => {
    const r = project();
    writeFileSync(
      join(evidenceDir(r), "capture-report.json"),
      JSON.stringify({ version: 1, project: "app", runs: [], shots: [], failures: [] }),
    );
    const err = await mergeLatest(r, {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LookoutError);
    expect((err as LookoutError).message).toContain("no runs");
  });

  test("holds even when the report still carries shots from a lost run", async () => {
    const r = project();
    writeCaptureReport(r);
    const p = join(evidenceDir(r), "capture-report.json");
    const report = JSON.parse(readFileSync(p, "utf8")) as { runs: unknown[] };
    report.runs = [];
    writeFileSync(p, JSON.stringify(report));
    await expect(mergeLatest(r, {})).rejects.toBeInstanceOf(LookoutError);
  });
});
