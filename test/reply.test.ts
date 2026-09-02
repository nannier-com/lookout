// Ingestion keeps a finding whose problem is written for one reader, and
// counts it, so the defect is not lost over its prose and the panel that
// wrote it can be taught.
import { describe, expect, test } from "bun:test";
import { ingestJudgeReply } from "../src/judge/reply.js";
import { panelOf } from "../src/judge/panels.js";
import type { ShotRecord } from "../src/types.js";

const SHOT = "web/app/home/rest/desktop/dark";
const shot = { id: SHOT, target: "app", route: "/home", routeName: "home", state: "rest", platform: "web", formFactor: "desktop", scheme: "dark", path: "x.png", hash: "h", bytes: 1, width: 1, height: 1, animated: false, capturedAt: "2026-09-01T00:00:00Z", runId: "r", deterministicFindings: [] } as ShotRecord;
const base = { shotId: SHOT, category: "contrast", attribute: "body-text", severity: "high", region: "content", expected: "e", observed: "o", confidence: "high", acceptance: [] };

describe("a thin problem", () => {
  test("survives, and is counted against the panel that wrote it", () => {
    const r = ingestJudgeReply(
      {
        findings: [
          { ...base, title: "Body text is too faint to read", problem: "The paragraph under the heading is grey on grey and a person has to squint to read it.\n\nBody text at 3.1:1 against the card, below the 4.5:1 minimum: contrast, body-text." },
          { ...base, title: "Body text is too faint to read", problem: "body text is too faint to read" },
        ],
        cleanShotIds: [],
      },
      { shots: [shot], project: "p", panel: panelOf("contrast") },
    );
    expect(r.findings.length).toBe(2);
    expect(r.rejected).toEqual([]);
    expect(r.degraded).toEqual([{ shotId: SHOT, category: "contrast", title: "Body text is too faint to read", judge: panelOf("contrast").name, lapses: ["title-again"] }]);
  });
});
