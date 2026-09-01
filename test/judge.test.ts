// Judge machinery tests: JSON extraction, batching, vocabulary enforcement,
// ledger keys, and a full engine round-trip through the mock claude binary.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  batchShots,
  buildJudgePrompt,
  extractJson,
  groupShots,
  judgeBatch,
  viewGroupId,
} from "../src/judge/engine.js";
import { groupHash, judgeIdentity, ledgerKey } from "../src/judge/ledger.js";
import { loadRubric } from "../src/judge/rubric.js";
// Redirects the lookout home away from the operator's. The bunfig preload
// does this for the whole suite, but it is only found when bun is run from the
// repository root, and the code under test here records incidents: importing it
// keeps that true whatever directory the run was started from.
import "./setup.js";
import { tmpProject } from "./tmp-project.js";
import type { ShotRecord } from "../src/types.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");

// The real composed prompt: the mock reads the manifest out of it.
const rubric = await loadRubric(tmpProject("lookout-judge-"));

function shot(id: string, over: Partial<ShotRecord> = {}): ShotRecord {
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
    runId: "test",
    deterministicFindings: [],
    ...over,
  };
}

// The mock picks its mode from MOCK_MODE, and other suites rely on it being
// unset so the mock can infer one from the prompt. Left behind, it makes an
// unrelated file fail depending on the order the suites happen to run in.
afterEach(() => {
  delete process.env.LOOKOUT_CLAUDE_BIN;
  delete process.env.MOCK_MODE;
  delete process.env.MOCK_SKIP_LAST;
  delete process.env.MOCK_JUDGE_CATEGORY;
  delete process.env.MOCK_JUDGE_REGION;
});

describe("extractJson", () => {
  test("reads a fenced block, the last when several, and bare objects", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```\ntext\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('noise {"a":3} trailing')).toEqual({ a: 3 });
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("view groups", () => {
  test("a view is its schemes and form factors together", () => {
    const pair = ["dark", "light"].flatMap((sc) =>
      ["desktop", "phone"].map((ff) => shot(`web/app/login/rest/${ff}/${sc}`)),
    );
    const groups = groupShots(pair);
    expect(groups.size).toBe(1);
    expect([...groups.values()][0]!.length).toBe(4);
    expect(viewGroupId(pair[0]!)).toBe("app|web|/login|rest");
  });

  test("different routes and states are different views", () => {
    const groups = groupShots([
      shot("web/app/login/rest/desktop/dark"),
      shot("web/app/login/menu-open/desktop/dark"),
      shot("web/app/home/rest/desktop/dark"),
    ]);
    expect(groups.size).toBe(3);
  });
});

describe("the design hand-off section is carried only when it applies", () => {
  test("a batch with no design reference does not carry the hand-off rules", () => {
    // They are a quarter of the rubric and the most nuanced passage in it, so
    // every project without hand-offs was paying that much of every prompt for
    // instructions that could never fire.
    expect(rubric.handoff.length).toBeGreaterThan(0);
    const prompt = buildJudgePrompt(
      rubric.text,
      "proj",
      [shot("web/app/x/rest/desktop/dark")],
      "/tmp",
      { handoff: rubric.handoff },
    );
    expect(prompt).not.toContain("Comparing against a design hand-off");
    // and no placeholder is left showing where it would have gone
    expect(prompt).not.toContain("{{");
  });

  test("a batch with a design reference carries them", () => {
    const prompt = buildJudgePrompt(
      rubric.text,
      "proj",
      [shot("web/app/x/rest/desktop/dark", { design: "/designs/x.png" })],
      "/tmp",
      { handoff: rubric.handoff },
    );
    expect(prompt).toContain("Comparing against a design hand-off");
    expect(prompt).toContain("design: /designs/x.png");
  });

  test("one design reference in a batch is enough to carry them", () => {
    const prompt = buildJudgePrompt(
      rubric.text,
      "proj",
      [
        shot("web/app/x/rest/desktop/dark"),
        shot("web/app/x/rest/phone/dark", { design: "/designs/x.png" }),
      ],
      "/tmp",
      { handoff: rubric.handoff },
    );
    expect(prompt).toContain("Comparing against a design hand-off");
  });
});

describe("context the judge already paid for", () => {
  const prompt = (shots: ShotRecord[], ctx = {}) =>
    buildJudgePrompt(rubric.text, "proj", shots, "/tmp", ctx);

  test("deterministic signals reach the judge instead of being discarded", () => {
    // axe knows the rule that fired and the overflow check knows the amount.
    // Both were computed, attached to the shot, and never shown to the one
    // participant that cannot measure anything for itself.
    const s = shot("web/app/x/rest/desktop/dark", {
      deterministicFindings: [
        {
          type: "axe-violation",
          severity: "error",
          message: "Button has no accessible name",
          meta: { ruleId: "button-name" },
        },
        {
          type: "horizontal-overflow",
          severity: "error",
          message: "main overflows by 42px at 390px",
        },
      ],
    });
    const out = prompt([s]);
    // The manifest's own line, not the rubric's prose about it.
    expect(out).toContain("\n  signals:");
    expect(out).toContain("Button has no accessible name");
    expect(out).toContain("overflows by 42px");
  });

  test("a shot with nothing measured carries no signals line", () => {
    expect(prompt([shot("web/app/x/rest/desktop/dark")])).not.toContain("\n  signals:");
  });

  test("informational checks are not dressed up as signals", () => {
    const s = shot("web/app/x/rest/desktop/dark", {
      deterministicFindings: [{ type: "console-error", severity: "info", message: "just noise" }],
    });
    expect(prompt([s])).not.toContain("just noise");
  });

  test("open findings are named so a re-file keeps its attribute", () => {
    // The attribute is free text and half of both the fingerprint and the
    // cluster key, so the same defect returning as "dark-theme-stuck" instead
    // of "theme-not-switching" mints a second issue and splits the first one's
    // attempt history.
    const out = prompt([shot("web/app/x/rest/desktop/dark")], {
      prior: [
        {
          shotId: "web/app/x/rest/desktop/dark",
          category: "color-scheme",
          attribute: "theme-not-switching",
          title: "Light scheme renders the dark theme",
        },
      ],
    });
    expect(out).toContain("ALREADY FILED");
    expect(out).toContain("[color-scheme/theme-not-switching]");
  });

  test("findings for other views are not carried into this batch", () => {
    const out = prompt([shot("web/app/x/rest/desktop/dark")], {
      prior: [
        {
          shotId: "web/app/somewhere-else/rest/desktop/dark",
          category: "contrast",
          attribute: "body-text",
          title: "Nothing to do with this batch",
        },
      ],
    });
    expect(out).not.toContain("ALREADY FILED");
  });

  test("nothing open leaves no empty section behind", () => {
    const out = prompt([shot("web/app/x/rest/desktop/dark")]);
    expect(out).not.toContain("ALREADY FILED");
    expect(out).not.toContain("{{");
  });
});

describe("batchShots", () => {
  test("one call per view, so the prompt unit and the cache unit are the same", () => {
    // Packing several views into one call quietly broke the cache. The rubric
    // asks for one finding per distinct defect on the most representative shot,
    // so a defect shared by two views in one batch was filed against one of
    // them and put the other's shots in cleanShotIds, recording that view
    // clean. A later scoped re-check then served "clean" from cache while the
    // defect was still on screen.
    const shots = ["a", "b", "c"].flatMap((r) =>
      ["desktop", "phone"].map((ff) => shot(`web/app/${r}/rest/${ff}/dark`)),
    );
    const batches = batchShots(shots);
    expect(batches).toHaveLength(3);
    for (const b of batches) expect(new Set(b.map(viewGroupId)).size).toBe(1);
    expect(batches.flat().length).toBe(shots.length);
  });

  test("a view is never split, however many shots it has", () => {
    // Both sides of a comparison have to reach the judge in one context.
    const big = Array.from({ length: 9 }, (_, i) =>
      shot(`web/app/big/rest/desktop/dark`, { id: `web/app/big/rest/ff${i}/dark` }),
    );
    const batches = batchShots([shot("web/app/small/rest/desktop/dark"), ...big]);
    const bigBatch = batches.find((b) => b.length === 9);
    expect(bigBatch).toBeDefined();
    expect(new Set(bigBatch!.map(viewGroupId)).size).toBe(1);
    expect(batches.flat().length).toBe(10);
  });
});

describe("judgeBatch through the mock binary", () => {
  test("accepts vocabulary findings, rejects unknown categories, keeps cost", async () => {
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "judge";
    const shots = [shot("web/app/x/rest/desktop/dark"), shot("web/app/x/rest/phone/dark")];
    const res = await judgeBatch(rubric.text, "proj", shots, "/tmp", "sonnet");
    expect(res.findings.length).toBe(1);
    expect(res.findings[0]!.category).toBe("contrast");
    // Every finding says what would prove it gone; the issue is built from these.
    expect(res.findings[0]!.acceptance).toEqual([
      "Body text is legible against the card background.",
    ]);
    expect(res.rejected.length).toBe(1);
    expect(res.rejected[0]!.reason).toContain("not-a-category");
    expect(res.cleanShotIds).toEqual(["web/app/x/rest/phone/dark"]);
    expect(res.costUsd).toBeCloseTo(0.0123);
    delete process.env.LOOKOUT_CLAUDE_BIN;
  });

  test("a shot the reply ruled on in neither list is reported, not assumed clean", async () => {
    // The contract says every shot appears in findings or cleanShotIds, exactly
    // so a judge that skipped one can be caught. Nothing read the result, so a
    // skipped shot was indistinguishable from a clean one and its whole view
    // was cached as clean, durably.
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "judge";
    process.env.MOCK_SKIP_LAST = "1";
    const shots = [
      shot("web/app/x/rest/desktop/dark"),
      shot("web/app/x/rest/phone/dark"),
      shot("web/app/x/rest/tablet/dark"),
    ];
    const res = await judgeBatch(rubric.text, "proj", shots, "/tmp", "sonnet");
    expect(res.unaccounted).toEqual(["web/app/x/rest/tablet/dark"]);
    delete process.env.MOCK_SKIP_LAST;
    delete process.env.LOOKOUT_CLAUDE_BIN;
  });

  test("composition, the holistic band, survives ingestion", async () => {
    // Added rather than substituted: a category name is part of every
    // fingerprint and cluster key in every backlog, so renaming one would
    // orphan the findings filed under it.
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "judge";
    process.env.MOCK_JUDGE_CATEGORY = "composition";
    const res = await judgeBatch(
      rubric.text,
      "proj",
      [shot("web/app/x/rest/desktop/dark")],
      "/tmp",
      "sonnet",
    );
    expect(res.findings.map((f) => f.category)).toEqual(["composition"]);
    delete process.env.MOCK_JUDGE_CATEGORY;
    delete process.env.LOOKOUT_CLAUDE_BIN;
  });

  test("a shell region is carried; a missing one degrades to content", async () => {
    // The mock's first finding names a region from the env; its second (the
    // rejected-category one) carries none, so the default path runs in the
    // same reply. A mangled region must cost precision, never the finding.
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "judge";
    process.env.MOCK_JUDGE_REGION = "shell-nav";
    const res = await judgeBatch(
      rubric.text,
      "proj",
      [shot("web/app/x/rest/desktop/dark")],
      "/tmp",
      "sonnet",
    );
    expect(res.findings.map((f) => f.region)).toEqual(["shell-nav"]);
    delete process.env.MOCK_JUDGE_REGION;
    delete process.env.LOOKOUT_CLAUDE_BIN;
  });

  test("an unknown region keeps the finding and lands as content", async () => {
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "judge";
    process.env.MOCK_JUDGE_REGION = "sidebar";
    const res = await judgeBatch(
      rubric.text,
      "proj",
      [shot("web/app/x/rest/desktop/dark")],
      "/tmp",
      "sonnet",
    );
    expect(res.findings.length).toBe(1);
    expect(res.findings[0]!.region).toBe("content");
    delete process.env.MOCK_JUDGE_REGION;
    delete process.env.LOOKOUT_CLAUDE_BIN;
  });

  test("a reply that accounts for every shot leaves nothing unaccounted", async () => {
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "judge";
    const shots = [shot("web/app/x/rest/desktop/dark"), shot("web/app/x/rest/phone/dark")];
    const res = await judgeBatch(rubric.text, "proj", shots, "/tmp", "sonnet");
    expect(res.unaccounted).toEqual([]);
    delete process.env.LOOKOUT_CLAUDE_BIN;
  });

  test("copes with prose around the fenced block", async () => {
    process.env.LOOKOUT_CLAUDE_BIN = MOCK;
    process.env.MOCK_MODE = "prose";
    const shots = [shot("web/app/y/rest/desktop/dark")];
    const res = await judgeBatch(rubric.text, "proj", shots, "/tmp", "sonnet");
    expect(res.findings.length).toBe(0);
    expect(res.cleanShotIds).toEqual(["web/app/y/rest/desktop/dark"]);
    delete process.env.LOOKOUT_CLAUDE_BIN;
  });
});

describe("ledger", () => {
  const identity = (over: Partial<Parameters<typeof judgeIdentity>[0]> = {}) =>
    judgeIdentity({ version: 3, rubricText: "R", refuteText: "F", handoffText: "H", model: "sonnet", ...over });

  test("key includes hash, judge skill version, prompt hash, and model", () => {
    const id = identity();
    expect(ledgerKey("abc", id)).toBe(`abc@v3@${id.promptHash}@sonnet`);
  });

  test("editing the rubric invalidates the verdicts it could have changed", () => {
    // The hole this closes: the key carried the skill VERSION, so a project
    // rubric edited without bumping past the shipped version, and every
    // neverFile change (which touches no version at all), left cached verdicts
    // standing that were formed under different rules.
    expect(identity({ rubricText: "R2" }).promptHash).not.toBe(identity().promptHash);
  });

  test("amending the refuting skill invalidates them too", () => {
    // The ledger stores POST-refutation findings, so the refuter's instructions
    // are an input to every entry. Its version was never in the key.
    expect(identity({ refuteText: "F2" }).promptHash).not.toBe(identity().promptHash);
  });

  test("the two texts cannot be transposed into the same hash", () => {
    expect(identity({ rubricText: "AB", refuteText: "C" }).promptHash).not.toBe(
      identity({ rubricText: "A", refuteText: "BC" }).promptHash,
    );
  });

  test("the same instructions give the same key, so the cache still hits", () => {
    expect(identity().promptHash).toBe(identity().promptHash);
  });

  test("group hash is order-independent", () => {
    const a = shot("web/app/login/rest/desktop/dark");
    const b = shot("web/app/login/rest/desktop/light");
    expect(groupHash([a, b])).toBe(groupHash([b, a]));
  });

  test("one member changing invalidates the whole view", () => {
    // The regression this keying exists for: fixing the light shot must send
    // its unchanged dark partner back to the judge too, or the comparative
    // finding filed against the pair silently reads as fixed.
    const dark = shot("web/app/login/rest/desktop/dark");
    const light = shot("web/app/login/rest/desktop/light");
    const before = groupHash([dark, light]);
    const after = groupHash([dark, { ...light, hash: "hash-after-the-fix" }]);
    expect(after).not.toBe(before);
  });
});

describe("what the manifest says about a moving view", () => {
  test("an animated shot is marked as one frame of a live animation", async () => {
    const { buildJudgePrompt } = await import("../src/judge/engine.js");
    const moving = shot("web/app/x/rest/desktop/dark", { animated: true });
    const still = shot("web/app/y/rest/desktop/dark");
    const prompt = buildJudgePrompt("{{manifest}}", "p", [moving, still], "/ev");
    const lines = prompt.split("- shotId: ");
    expect(lines.find((l) => l.startsWith("web/app/x"))).toContain("one frame of it");
    expect(lines.find((l) => l.startsWith("web/app/y"))).not.toContain("one frame of it");
  });
});
