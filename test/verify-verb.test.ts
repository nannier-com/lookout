// The `lookout verify --criteria` verb: the flag guards, criteria resolution,
// the report it writes, and the exit code an orchestrating session branches on.
//
// The whole composition runs for real except the capture itself: runCapture is
// the one dependency that needs a live browser and a served app, so it is
// stubbed at the module seam and handed a seeded capture report on disk.
// Everything downstream (report load, skill, the claude subprocess, the report
// write, the exit code) is the real code against test/mock-claude.ts.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as captureModule from "../src/verbs/capture.js";
import { verify } from "../src/verbs/verify.js";
import { buildVerifyPrompt, MAX_VERIFY_SHOTS, type CriterionResult } from "../src/judge/criteria.js";
import { gatherSignals } from "../src/skills/signals.js";
import { loadSkill } from "../src/skills/load.js";
import { evidenceDir } from "../src/config.js";
import { tmpProject } from "./tmp-project.js";
import type { ResolvedConfig, ShotRecord } from "../src/types.js";
import type { Parsed } from "../src/util.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");
const skill = await loadSkill(tmpProject("lookout-vv-skill-"), "verify-acceptance");

// When a test arms this, runCapture answers from the seeded report instead of
// launching a browser; unarmed, it delegates, so nothing leaks to other files.
let stubResolved: ResolvedConfig | null = null;
const realRunCapture = captureModule.runCapture;
mock.module("../src/verbs/capture.js", () => ({
  ...captureModule,
  runCapture: (parsed: Parsed) => {
    const r = stubResolved;
    if (!r) return realRunCapture(parsed);
    return Promise.resolve({
      resolved: r,
      outcome: {
        runId: "r2",
        shots: 0,
        findings: { errors: 0, warnings: 0, infos: 0 },
        failures: [],
        reportPath: join(evidenceDir(r), "capture-report.json"),
        evidenceDir: evidenceDir(r),
      },
    });
  },
}));

function shot(id: string, runIdValue: string): ShotRecord {
  const [platform, target, routeSlug, state, formFactor, scheme] = id.split("/");
  return {
    id,
    target: target!,
    route: `/${routeSlug}`,
    routeName: routeSlug!,
    state: state!,
    platform: platform as ShotRecord["platform"],
    formFactor: formFactor as ShotRecord["formFactor"],
    scheme: scheme as ShotRecord["scheme"],
    path: `${id}.png`,
    hash: `hash-${id}`,
    bytes: 1,
    width: 100,
    height: 100,
    animated: false,
    capturedAt: "2026-08-25T00:00:00Z",
    runId: runIdValue,
    deterministicFindings: [],
  };
}

/** A project whose evidence already holds two runs; `latest` belongs to r2. */
function seeded(prefix: string, latest: ShotRecord[]): ResolvedConfig {
  const r = tmpProject(prefix);
  mkdirSync(evidenceDir(r), { recursive: true });
  writeFileSync(
    join(evidenceDir(r), "capture-report.json"),
    JSON.stringify({
      version: 1,
      project: r.project,
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T01:00:00.000Z",
      runs: [
        { id: "r1", startedAt: "2026-08-25T00:00:00.000Z" },
        { id: "r2", startedAt: "2026-08-25T01:00:00.000Z" },
      ],
      shots: [shot("web/app/stale/rest/desktop/light", "r1"), ...latest],
    }),
  );
  return r;
}

function runVerify(r: ResolvedConfig, flags: Parsed["flags"]): Promise<number> {
  stubResolved = r;
  return verify({ flags: { json: true, ...flags }, positionals: [] });
}

interface WrittenReport {
  verifiedAt: string;
  model: string;
  criteriaSource: string;
  shots: string[];
  criteria: CriterionResult[];
  summary: string;
}

function readReport(r: ResolvedConfig): WrittenReport {
  return JSON.parse(
    readFileSync(join(evidenceDir(r), "verify-report.json"), "utf8"),
  ) as WrittenReport;
}

/** Route the mock's argv to a file so a test can read the prompt it was sent. */
function armArgvCapture(): string {
  const f = join(mkdtempSync(join(tmpdir(), "lookout-vv-argv-")), "argv.jsonl");
  process.env.MOCK_ARGV_FILE = f;
  return f;
}

function promptOf(argvFile: string): string {
  const argv = JSON.parse(readFileSync(argvFile, "utf8").trim().split("\n")[0]!) as string[];
  return argv[argv.indexOf("-p") + 1]!;
}

beforeEach(() => {
  process.env.LOOKOUT_CLAUDE_BIN = MOCK;
  process.env.MOCK_MODE = "criteria";
  process.env.LOOKOUT_HOME = mkdtempSync(join(tmpdir(), "lookout-home-"));
});

afterEach(() => {
  delete process.env.LOOKOUT_CLAUDE_BIN;
  delete process.env.MOCK_MODE;
  delete process.env.MOCK_CRITERIA;
  delete process.env.MOCK_ARGV_FILE;
  delete process.env.LOOKOUT_HOME;
  stubResolved = null;
});

describe("the flags that gate the run", () => {
  // The guards throw before capture; the armed stub only makes a regression
  // fail fast ("capture produced no report") instead of reaching for a browser.
  test("no --criteria refuses to run", async () => {
    await expect(runVerify(tmpProject("lookout-vv-guard-"), {})).rejects.toThrow(
      "verify needs --criteria",
    );
    await expect(
      runVerify(tmpProject("lookout-vv-guard-"), { criteria: true }),
    ).rejects.toThrow("verify needs --criteria");
  });

  test("criteria too short to mean anything are refused, inline or from a file", async () => {
    const r = tmpProject("lookout-vv-short-");
    await expect(runVerify(r, { criteria: "meh" })).rejects.toThrow("too short");
    const tiny = join(r.projectDir, "tiny.md");
    writeFileSync(tiny, "hi\n");
    await expect(runVerify(r, { criteria: tiny })).rejects.toThrow("too short");
  });
});

describe("where the ticket comes from", () => {
  test("a --criteria value that is a file on disk is read as the ticket", async () => {
    const r = seeded("lookout-vv-file-", [shot("web/app/root/rest/desktop/dark", "r2")]);
    const ticket = join(r.projectDir, "ticket.md");
    writeFileSync(ticket, "The checkout button is visible on the phone viewport.\n");
    const argvFile = armArgvCapture();

    expect(await runVerify(r, { criteria: ticket, model: "opus" })).toBe(1);
    const report = readReport(r);
    expect(report.criteriaSource).toBe(ticket);
    expect(report.model).toBe("opus");
    // The file's text, not its path, is what the verifier is asked about.
    expect(promptOf(argvFile)).toContain("The checkout button is visible");
  });

  test("anything else is the ticket itself", async () => {
    const r = seeded("lookout-vv-inline-", [shot("web/app/root/rest/desktop/dark", "r2")]);
    const argvFile = armArgvCapture();

    await runVerify(r, { criteria: "Inline criteria: the header stays put." });
    expect(readReport(r).criteriaSource).toBe("(inline)");
    expect(promptOf(argvFile)).toContain("Inline criteria: the header stays put.");
  });
});

describe("the report on disk", () => {
  test("scoped to the latest run, raw reply withheld, evidence ids real", async () => {
    const a = shot("web/app/root/rest/desktop/dark", "r2");
    const b = shot("web/app/settings/rest/phone/light", "r2");
    const r = seeded("lookout-vv-report-", [a, b]);

    expect(await runVerify(r, { criteria: "The page shows a Security section." })).toBe(1);
    const report = readReport(r);
    expect(report.model).toBe("sonnet");
    expect(Date.parse(report.verifiedAt)).toBeGreaterThan(0);
    // The r1 shot is on disk but not offered: only the run just captured rules.
    expect(report.shots).toEqual([a.id, b.id]);
    expect(report.criteria).toHaveLength(3);
    expect(report.criteria[0]!.evidence).toEqual([a.id]);
    expect(report.summary).toContain("1 pass");
    expect("raw" in report).toBe(false);
  });

  test("gatherSignals can read what the verb wrote", async () => {
    const r = seeded("lookout-vv-signal-", [shot("web/app/root/rest/desktop/dark", "r2")]);
    await runVerify(r, { criteria: "Saving emits an audit log entry and shows a toast." });

    // The mock rules its third criterion not-verifiable; that is the
    // verify-acceptance skill's evidence, keyed to the criteria source.
    const signals = (await gatherSignals(r)).filter((s) => s.skill === "verify-acceptance");
    expect(signals).toHaveLength(1);
    expect(signals[0]!.summary).toContain("audit log");
    expect(signals[0]!.source).toContain("(inline)");
  });
});

describe("the exit code is the contract", () => {
  const inline = "The header is visible on every viewport.";
  const noFail = JSON.stringify({
    criteria: [
      { id: 1, text: "header visible", verdict: "pass", reasoning: "shown", evidence: [] },
      { id: 2, text: "audit row written", verdict: "not-verifiable", reasoning: "not visual", evidence: [] },
    ],
    summary: "1 pass, 1 not verifiable",
  });

  test("a failed criterion exits 1", async () => {
    const r = seeded("lookout-vv-fail-", [shot("web/app/root/rest/desktop/dark", "r2")]);
    expect(await runVerify(r, { criteria: inline })).toBe(1);
  });

  test("not-verifiable alone passes without --strict", async () => {
    process.env.MOCK_CRITERIA = noFail;
    const r = seeded("lookout-vv-lax-", [shot("web/app/root/rest/desktop/dark", "r2")]);
    expect(await runVerify(r, { criteria: inline })).toBe(0);
  });

  test("--strict turns not-verifiable into a failure", async () => {
    process.env.MOCK_CRITERIA = noFail;
    const r = seeded("lookout-vv-strict-", [shot("web/app/root/rest/desktop/dark", "r2")]);
    expect(await runVerify(r, { criteria: inline, strict: true })).toBe(1);
  });

  test("an all-pass run survives --strict", async () => {
    process.env.MOCK_CRITERIA = JSON.stringify({
      criteria: [{ id: 1, text: "header visible", verdict: "pass", reasoning: "shown", evidence: [] }],
      summary: "1 pass",
    });
    const r = seeded("lookout-vv-pass-", [shot("web/app/root/rest/desktop/dark", "r2")]);
    expect(await runVerify(r, { criteria: inline, strict: true })).toBe(0);
  });
});

describe("what the verifier can be asked to hold", () => {
  test("an empty latest run is refused rather than ruled on faith", async () => {
    // r1 evidence exists on disk; it must not be borrowed for this run.
    const r = seeded("lookout-vv-empty-", []);
    await expect(runVerify(r, { criteria: "The header is visible." })).rejects.toThrow(
      "no evidence captured",
    );
  });

  test("the shot cap throws before any model is paid", async () => {
    const many = Array.from({ length: MAX_VERIFY_SHOTS + 1 }, (_, i) =>
      shot(`web/app/r${i}/rest/desktop/dark`, "r2"),
    );
    const r = seeded("lookout-vv-cap-", many);
    const argvFile = armArgvCapture();
    await expect(runVerify(r, { criteria: "The header is visible." })).rejects.toThrow(
      `verify cap of ${MAX_VERIFY_SHOTS}`,
    );
    expect(existsSync(argvFile)).toBe(false);
  });
});

describe("the prompt the verifier is handed", () => {
  test("manifest lines carry the axes; ticket and project land verbatim", () => {
    const a = shot("web/app/root/rest/desktop/dark", "r2");
    const b = shot("web/app/settings/rest/phone/light", "r2");
    const prompt = buildVerifyPrompt(skill.text, "proj", "TICKET TEXT HERE", [a, b], "/ev");
    expect(prompt).toContain(`- shotId: ${a.id}`);
    expect(prompt).toContain(`file: /ev/${a.path}`);
    expect(prompt).toContain(
      "route: /root  state: rest  formFactor: desktop  scheme: dark  size: 100x100",
    );
    expect(prompt).toContain("SHOTS (2)");
    expect(prompt).toContain("TICKET TEXT HERE");
    expect(prompt).toContain('"proj"');
  });
});
