// Two judges reaching one account of what is wrong.
//
// The cases that matter are the ones where the dialogue does NOT go to plan,
// because those decide whether a second AI makes lookout better or merely
// louder: a challenger that cannot be reached must leave the first judge's
// verdict standing and say so, and a challenger that disagrees must not be able
// to delete the finding it disagrees with.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { judgeWithDialogue, type Roster } from "../src/judge/dialogue.js";
import { evidenceDir } from "../src/config.js";
import { tmpProject } from "./tmp-project.js";
import type { ShotRecord } from "../src/types.js";

const CLAUDE = join(import.meta.dir, "mock-claude.ts");
const CODEX = join(import.meta.dir, "mock-codex.ts");

afterEach(() => {
  delete process.env.LOOKOUT_CLAUDE_BIN;
  delete process.env.LOOKOUT_CODEX_BIN;
  delete process.env.MOCK_MODE;
  delete process.env.MOCK_CHALLENGE;
  delete process.env.MOCK_CHALLENGE_ADD;
});

function shot(id: string): ShotRecord {
  const [platform, target, routeSlug, state, formFactor, scheme] = id.split("/");
  return {
    id, target: target!, route: `/${routeSlug}`, routeName: routeSlug!, state: state!,
    platform: platform as ShotRecord["platform"],
    formFactor: formFactor as ShotRecord["formFactor"],
    scheme: scheme as ShotRecord["scheme"],
    path: `${id}.png`, hash: `hash-${id}`, bytes: 1, width: 100, height: 100,
    animated: false, capturedAt: "2026-08-25T00:00:00Z", runId: "test", deterministicFindings: [],
  } as ShotRecord;
}

const PANEL = { name: "judge-geometry", categories: ["spacing", "alignment"] as const };
const SKILL = "## Category vocabulary\n\n- spacing: the spacing bullet.\n\n## Shots\n{{manifest}}\n{{priorFindings}}";
const CHALLENGE = "Rule on each.\n\n## The shots\n{{manifest}}\n\n## This panel's lane\n\n{{lane}}\n\n"
  + "=== FINDINGS ===\n{{findings}}\n=== END ===\n{{howToOpen}}";

function project() {
  const r = tmpProject("lookout-dialogue-");
  mkdirSync(evidenceDir(r), { recursive: true });
  return r;
}

const s = shot("web/app/home/rest/desktop/light");

function roster(withChallenger: boolean): Roster {
  return {
    proposer: { ai: "claude-code", model: "sonnet" },
    ...(withChallenger ? { challenger: { ai: "codex", model: "gpt-x" } } : {}),
  };
}

describe("one judge", () => {
  test("with no second AI configured, nothing about a run changes", async () => {
    const r = project();
    process.env.LOOKOUT_CLAUDE_BIN = CLAUDE;
    process.env.MOCK_MODE = "judge";
    const res = await judgeWithDialogue(SKILL, r.project, [s], evidenceDir(r), roster(false), {
      projectDir: r.projectDir, panel: PANEL,
    });
    expect(res.dialogued).toBe(true);
    expect(res.findings.length).toBeGreaterThan(0);
    // Still stamped with who filed it: that is true of a single-AI run too, and
    // a reader should never have to guess.
    expect(res.findings.every((f) => f.oracle === "claude-code")).toBe(true);
    expect(res.findings.every((f) => f.consensus === undefined)).toBe(true);
  });
});

describe("two judges", () => {
  test("agreement is recorded on every finding the second one saw", async () => {
    const r = project();
    process.env.LOOKOUT_CLAUDE_BIN = CLAUDE;
    process.env.LOOKOUT_CODEX_BIN = CODEX;
    process.env.MOCK_MODE = "judge";
    const res = await judgeWithDialogue(SKILL, r.project, [s], evidenceDir(r), roster(true), {
      projectDir: r.projectDir, panel: PANEL, challengeSkill: CHALLENGE,
    });
    expect(res.dialogued).toBe(true);
    for (const f of res.findings) {
      expect(f.consensus?.reportedBy).toBe("claude-code");
      expect(f.consensus?.agreedBy).toEqual(["codex"]);
    }
  });

  test("a disagreement is kept, not applied: the finding still stands", async () => {
    const r = project();
    process.env.LOOKOUT_CLAUDE_BIN = CLAUDE;
    process.env.LOOKOUT_CODEX_BIN = CODEX;
    process.env.MOCK_MODE = "judge";
    process.env.MOCK_CHALLENGE = "dispute";
    const res = await judgeWithDialogue(SKILL, r.project, [s], evidenceDir(r), roster(true), {
      projectDir: r.projectDir, panel: PANEL, challengeSkill: CHALLENGE,
    });
    // Nothing an AI saw is thrown away because another disagreed. Both
    // accounts are on the record and a person decides.
    expect(res.findings.length).toBeGreaterThan(0);
    for (const f of res.findings) {
      expect(f.consensus?.disputedBy?.[0]?.oracle).toBe("codex");
      expect(f.consensus?.agreedBy).toBeUndefined();
    }
  });

  test("what the second judge adds is filed as its own, unvouched for", async () => {
    const r = project();
    process.env.LOOKOUT_CLAUDE_BIN = CLAUDE;
    process.env.LOOKOUT_CODEX_BIN = CODEX;
    process.env.MOCK_MODE = "judge";
    process.env.MOCK_CHALLENGE_ADD = "1";
    const res = await judgeWithDialogue(SKILL, r.project, [s], evidenceDir(r), roster(true), {
      projectDir: r.projectDir, panel: PANEL, challengeSkill: CHALLENGE,
    });
    const added = res.findings.filter((f) => f.oracle === "codex");
    expect(added).toHaveLength(1);
    // The proposer has not seen it, so nothing may claim it agreed.
    expect(added[0]!.consensus?.reportedBy).toBe("codex");
    expect(added[0]!.consensus?.agreedBy).toBeUndefined();
  });

  test("a challenger that cannot be reached leaves the verdict standing, and says so", async () => {
    const r = project();
    process.env.LOOKOUT_CLAUDE_BIN = CLAUDE;
    process.env.LOOKOUT_CODEX_BIN = join(import.meta.dir, "no-such-mock.ts");
    process.env.MOCK_MODE = "judge";
    const res = await judgeWithDialogue(SKILL, r.project, [s], evidenceDir(r), roster(true), {
      projectDir: r.projectDir, panel: PANEL, challengeSkill: CHALLENGE,
    });
    // The proposal is real and is kept. What must not happen is caching it as
    // though two judges had agreed, so the caller is told there was no dialogue.
    expect(res.dialogued).toBe(false);
    expect(res.undialoguedReason).toBeTruthy();
    expect(res.findings.length).toBeGreaterThan(0);
    expect(res.findings.every((f) => f.consensus === undefined)).toBe(true);
  });
});
