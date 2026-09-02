// What verify-fix prints after a ruling, and what --json carries: the same
// facts the regenerated document took, so a session reading stdout and one
// opening the file fresh learn the same things about the attempt.
import { describe, expect, test } from "bun:test";
import { fixPayload, printFixOutcome, type FixOutcomeArgs } from "../src/verify/outcome-report.js";

function capture(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { fn(); } finally { console.log = orig; }
  return lines.join("\n");
}

const base: FixOutcomeArgs = {
  issueId: "418203",
  verdict: "still-open",
  attempt: 1,
  maxAttempts: 2,
  judgeNote: "the badge still covers the heading",
  ruledCriteria: [
    { id: "a", text: "The heading reads unobstructed", source: "judge", verdict: "unmet", note: "The badge still sits over the R.", evidence: ["web/app/dash/rest/phone/dark"], suggestion: "move the badge below the heading" },
    { id: "b", text: "The badge sits clear", source: "judge", verdict: "pending" },
    { id: "u", text: "Every screenshot was re-captured, and at least one changed.", source: "universal", verdict: "met", note: "1 of 6 screenshot(s) changed." },
  ],
  spawned: [{ issue: { id: "552140", title: "The drawer overlaps the footer", severity: "medium" }, causedByThisFix: true }],
  sheet: { path: "/abs/verify-418203.png", tiles: 6, omitted: 0, columns: 3, rows: 2 },
  stillOpen: [{ title: "Header icons collide with the activity row", shotId: "web/app/dash/rest/phone/dark", observed: "the badge still covers the heading" }],
  changedShots: 1,
  baselineShots: 6,
  totalShots: 6,
  unclosable: ["/settings"],
  reportedCommit: "cafef00d",
  reportedNote: "rebuilt the bundle",
  observed: { head: "cafef00d", dirty: true, dirtyFiles: ["src/Header.tsx"], filesChanged: ["src/Header.tsx"] },
  docPath: "/proj/.lookout/issues/418203/Issue.md",
  baseline: { runId: "check-1", finishedAt: "2026-08-28T14:02:11.000Z" },
  photographed: { url: "http://127.0.0.1:5999", routes: ["/dash", "/settings"] },
  flags: { viewports: "phone" },
  costUsd: 0.12,
};

describe("the printed account of a ruling", () => {
  test("says what an attempt cost, what was photographed and compared, what is still open, and where the record is", () => {
    const out = capture(() => printFixOutcome({ ...base, json: false, payload: fixPayload(base) }));
    expect(out).toContain("418203: still-open (attempt 1 of 2; 1 more before it blocks)");
    expect(out).toContain("  judge: the badge still covers the heading");
    expect(out).toContain("  photographed: http://127.0.0.1:5999 at /dash, /settings; phone; dark, light");
    expect(out).toContain("  compared against: run check-1, finished 2026-08-28T14:02:11.000Z; 1 of 6 comparable screenshot(s) changed (6 in scope)");
    expect(out).toContain("  pixels unchanged since filing on /settings: nothing there could close");
    expect(out).toContain("    - Header icons collide with the activity row (web/app/dash/rest/phone/dark)");
    expect(out).toContain("      judge: the badge still covers the heading");
    expect(out).toContain("  acceptance: 1/3 met, 1 failing, 1 not checked");
    expect(out).toContain("    [!] The heading reads unobstructed");
    expect(out).toContain("        not met: The badge still sits over the R.");
    expect(out).toContain("        decided on: web/app/dash/rest/phone/dark");
    expect(out).toContain("        suggestion: move the badge below the heading");
    expect(out).toContain("    [ ] The badge sits clear");
    expect(out).toContain("    [x] Every screenshot was re-captured");
    expect(out).toContain("  recorded: commit cafef00d; 1 uncommitted file(s): src/Header.tsx; changed since the previous attempt: src/Header.tsx");
    expect(out).toContain('    note: "rebuilt the bundle"');
    expect(out).toContain("  new issue 552140: The drawer overlaps the footer (medium), on pixels this fix moved");
    expect(out).toContain("  next: the defect is still there; the finding stays open. 1 new issue(s) were filed in this run (552140); they are separate work");
    expect(out).toContain("        /proj/.lookout/issues/418203/Issue.md now carries this attempt.");
    expect(out).toContain("contact sheet: /abs/verify-418203.png");
  });

  test("a blocked ruling names the reopen command; a pass counts no attempts left", () => {
    const blocked = capture(() => printFixOutcome({ ...base, verdict: "blocked", attempt: 2, json: false, payload: fixPayload({ ...base, verdict: "blocked", attempt: 2 }) }));
    expect(blocked).toContain("418203: blocked (attempt 2 of 2; out of attempts)");
    expect(blocked).toContain("`lookout backlog set --issue 418203 --status open` reopens it");
    const passed = capture(() => printFixOutcome({ ...base, verdict: "passed", stillOpen: [], json: false, payload: fixPayload({ ...base, verdict: "passed", stillOpen: [] }) }));
    expect(passed).toContain("418203: passed (attempt 1 of 2)");
    expect(passed).not.toContain("still open:");
  });

  test("no previous capture is said as such", () => {
    const out = capture(() => printFixOutcome({ ...base, baseline: null, baselineShots: 0, changedShots: 0, json: false, payload: fixPayload({ ...base, baseline: null }) }));
    expect(out).toContain("  compared against: no previous capture; 0 of 0 comparable screenshot(s) changed (6 in scope)");
  });
});

describe("the --json payload", () => {
  test("carries the same facts as objects, and prints verbatim", () => {
    const p = fixPayload(base);
    expect(p.attemptsLeft).toBe(1);
    expect(p.stillOpen).toEqual(base.stillOpen);
    expect(p.photographed).toEqual({ url: "http://127.0.0.1:5999", routes: ["/dash", "/settings"], formFactors: ["phone"], schemes: ["dark", "light"] });
    expect(p.baseline).toEqual({ runId: "check-1", finishedAt: "2026-08-28T14:02:11.000Z" });
    expect(p.reported).toEqual({ commit: "cafef00d", note: "rebuilt the bundle" });
    expect(p.observed).toEqual(base.observed);
    expect(p.doc).toBe("/proj/.lookout/issues/418203/Issue.md");
    expect((p.acceptance as { evidence: string[]; suggestion: string | null }[])[0]).toMatchObject({ evidence: ["web/app/dash/rest/phone/dark"], suggestion: "move the badge below the heading" });
    expect(fixPayload({ ...base, verdict: "passed" }).attemptsLeft).toBeNull();
    // The whole payload survives JSON: nothing in it is a function, a Map or a Set.
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});
