// Ingestion keeps a finding whose problem is written for one reader, and
// counts it, so the defect is not lost over its prose and the panel that
// wrote it can be taught.
import { describe, expect, test } from "bun:test";
import { ingestJudgeReply } from "../src/judge/reply.js";
import { panelOf } from "../src/judge/panels.js";
import { tmpProject } from "./tmp-project.js";
import type { ShotRecord } from "../src/types.js";

// A real directory, because ingestion records incidents against it and
// `Incident.project` is a project DIRECTORY. A display name here used to read
// as a relative path, resolve against the working directory, and file this
// file's invented contract failures in whatever repository the suite was run
// from. `incidentLogDir` refuses a non-absolute project now, so the leak is
// closed either way, but a fixture that spells the contract wrongly is a
// fixture the next person copies.
const PROJECT = tmpProject("lookout-reply-").projectDir;

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
      { shots: [shot], project: PROJECT, panel: panelOf("contrast") },
    );
    expect(r.findings.length).toBe(2);
    expect(r.rejected).toEqual([]);
    expect(r.degraded).toEqual([{ shotId: SHOT, category: "contrast", title: "Body text is too faint to read", judge: panelOf("contrast").name, lapses: ["title-again"] }]);
  });
});

// A defect visible on four shots of a view is one defect and four sightings.
// The judge files it once and names the rest; these hold the expansion that
// makes each named shot a ruled-on shot rather than a line of prose.
describe("sibling shots", () => {
  const other = { ...shot, id: "web/app/home/rest/phone/dark", formFactor: "phone" } as ShotRecord;
  const third = { ...shot, id: "web/app/home/rest/desktop/light", scheme: "light" } as ShotRecord;
  const finding = { ...base, title: "Body text is too faint to read", problem: "The paragraph under the heading is grey on grey and a person has to squint.\n\nBody text at 3.1:1 against the card: contrast, body-text." };

  test("each named shot becomes its own finding, marked as a copy", () => {
    const r = ingestJudgeReply(
      { findings: [{ ...finding, alsoShotIds: [other.id, third.id] }], cleanShotIds: [] },
      { shots: [shot, other, third], project: PROJECT, panel: panelOf("contrast") },
    );
    expect(r.findings.map((f) => f.shotId)).toEqual([SHOT, other.id, third.id]);
    expect(r.findings.map((f) => f.siblingOf)).toEqual([undefined, SHOT, SHOT]);
    // The copies are the same defect: same lane, same name, same prose.
    for (const f of r.findings) {
      expect(f.category).toBe("contrast");
      expect(f.attribute).toBe("body-text");
      expect(f.problem).toBe(r.findings[0]!.problem);
    }
  });

  test("a named shot is accounted for, so nothing is left unruled", () => {
    const r = ingestJudgeReply(
      { findings: [{ ...finding, alsoShotIds: [other.id] }], cleanShotIds: [third.id] },
      { shots: [shot, other, third], project: PROJECT, panel: panelOf("contrast") },
    );
    expect(r.unaccounted).toEqual([]);
  });

  test("a shot outside this batch is dropped and the finding stands", () => {
    const r = ingestJudgeReply(
      { findings: [{ ...finding, alsoShotIds: ["web/app/other/rest/desktop/dark", other.id] }], cleanShotIds: [third.id] },
      { shots: [shot, other, third], project: PROJECT, panel: panelOf("contrast") },
    );
    expect(r.findings.map((f) => f.shotId)).toEqual([SHOT, other.id]);
    expect(r.rejected).toEqual([]);
    expect(r.unaccounted).toEqual([]);
  });

  test("naming its own shot, or naming one twice, adds nothing", () => {
    const r = ingestJudgeReply(
      { findings: [{ ...finding, alsoShotIds: [SHOT, other.id, other.id] }], cleanShotIds: [third.id] },
      { shots: [shot, other, third], project: PROJECT, panel: panelOf("contrast") },
    );
    expect(r.findings.map((f) => f.shotId)).toEqual([SHOT, other.id]);
  });

  test("a thin problem is counted once, not once per shot it was seen on", () => {
    const r = ingestJudgeReply(
      {
        findings: [{ ...base, title: "Body text is too faint to read", problem: "body text is too faint to read", alsoShotIds: [other.id, third.id] }],
        cleanShotIds: [],
      },
      { shots: [shot, other, third], project: PROJECT, panel: panelOf("contrast") },
    );
    expect(r.findings.length).toBe(3);
    expect(r.degraded.length).toBe(1);
    expect(r.degraded[0]?.shotId).toBe(SHOT);
  });
});
