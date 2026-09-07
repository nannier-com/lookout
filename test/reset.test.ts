// Throwing away what lookout collected here: what goes, what stays, and what a
// reset has to reach beyond the files.
//
// The interesting case is not that the delete works. It is that half of what
// the page shows is not on disk at all, and a reset that only unlinked would
// leave the header counting a run whose files were gone. That is exactly the
// state this was written against: the record deleted by hand, the page still
// reporting forty shots. So the session's own memory is asserted here too.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceDir, lookoutDir } from "../src/config.js";
import { narrationPath } from "../src/report/narration.js";
import { clearNarration, resetProject } from "../src/ui/reset.js";
import { session } from "../src/ui/session.js";
import type { ResolvedConfig } from "../src/types.js";

/** A project with a full record: a backlog, an issue folder, a workspace, a queue. */
function project(): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), "lookout-reset-"));
  const r = {
    config: {} as ResolvedConfig["config"],
    configPath: join(dir, "lookout.config.ts"),
    projectDir: dir,
    project: "app",
  } as ResolvedConfig;
  mkdirSync(join(lookoutDir(r), "issues", "ISSUE-1"), { recursive: true });
  mkdirSync(evidenceDir(r), { recursive: true });
  writeFileSync(join(lookoutDir(r), "backlog.json"), '{"findings":{},"issues":{}}');
  writeFileSync(join(lookoutDir(r), "queue.json"), "[]");
  writeFileSync(join(lookoutDir(r), "issues", "ISSUE-1", "before.png"), "px");
  writeFileSync(join(evidenceDir(r), "events.jsonl"), '{"kind":"run-start"}\n');
  writeFileSync(narrationPath(r), '{"kind":"say","call":"c1","text":"a verdict"}\n');
  writeFileSync(join(lookoutDir(r), "ui.json"), '{"baseUrl":"http://localhost:3000"}');
  return r;
}

describe("clearing the judge's transcript", () => {
  test("empties the file without unlinking it", async () => {
    const p = project();
    expect(readFileSync(narrationPath(p), "utf8").length).toBeGreaterThan(0);
    await clearNarration(p);
    // Still there: a run in flight holds this path and goes on appending, and
    // unlinking underneath the writer would send the rest of the run's
    // narration to a file nothing reads.
    expect(existsSync(narrationPath(p))).toBe(true);
    expect(readFileSync(narrationPath(p), "utf8")).toBe("");
  });

  test("leaves the findings alone", async () => {
    const p = project();
    await clearNarration(p);
    expect(existsSync(join(lookoutDir(p), "backlog.json"))).toBe(true);
    expect(existsSync(join(lookoutDir(p), "issues", "ISSUE-1", "before.png"))).toBe(true);
    expect(existsSync(join(evidenceDir(p), "events.jsonl"))).toBe(true);
  });

  test("survives a project with nothing captured yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lookout-reset-bare-"));
    const p = { projectDir: dir, project: "app" } as ResolvedConfig;
    await clearNarration(p);
    expect(existsSync(narrationPath(p))).toBe(false);
  });
});

describe("resetting a project", () => {
  test("deletes the record and keeps the settings", async () => {
    const p = project();
    const outcome = await resetProject(p);
    expect(outcome.ok).toBe(true);
    for (const gone of [
      join(lookoutDir(p), "backlog.json"),
      join(lookoutDir(p), "queue.json"),
      join(lookoutDir(p), "issues"),
      evidenceDir(p),
    ]) {
      expect(existsSync(gone)).toBe(false);
    }
    // Wiping the record and being asked to choose the folder again are two
    // acts, and only one of them was asked for.
    expect(existsSync(join(lookoutDir(p), "ui.json"))).toBe(true);
    expect(readFileSync(join(lookoutDir(p), "ui.json"), "utf8")).toContain("localhost:3000");
  });

  test("reports what it removed", async () => {
    const p = project();
    const outcome = await resetProject(p);
    expect(outcome.removed.sort()).toEqual(["backlog.json", "issues", "queue.json", "workspace"]);
    expect(outcome.removed).not.toContain("ui.json");
  });

  test("empties the queue this process holds, not only its sidecar", async () => {
    const p = project();
    // `session.queue` is the authority and `queue.json` is the sidecar, so a
    // reset that only deleted the file would empty nothing the page can see.
    session.queue = [{ issue: "ISSUE-1", at: "now" }] as unknown as typeof session.queue;
    const before = session.queueRev;
    await resetProject(p);
    expect(session.queue).toEqual([]);
    expect(session.queueRev).toBeGreaterThan(before);
    expect(session.queueMtime).toBe(0);
  });

  test("clears a failure left over from the run that no longer exists", async () => {
    const p = project();
    session.lastFailure = { code: 1, message: "target down" };
    await resetProject(p);
    expect(session.lastFailure).toBeNull();
  });

  test("refuses while a run is in flight, and deletes nothing", async () => {
    const p = project();
    // A check writes screenshots, events and narration continuously, so
    // deleting the workspace underneath one would race the writer and leave a
    // half-rebuilt directory that looks like a fresh capture without being one.
    session.running = {
      child: { exitCode: null, killed: false },
      project: p,
      stopping: false,
      kind: "check",
    } as unknown as typeof session.running;
    try {
      const outcome = await resetProject(p);
      expect(outcome.ok).toBe(false);
      expect(outcome.why).toContain("run is in flight");
      expect(existsSync(join(lookoutDir(p), "backlog.json"))).toBe(true);
      expect(existsSync(join(lookoutDir(p), "issues", "ISSUE-1", "before.png"))).toBe(true);
    } finally {
      session.running = null;
    }
  });

  test("is safe on a project that has no record at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lookout-reset-none-"));
    const p = { projectDir: dir, project: "app" } as ResolvedConfig;
    // The state the page was found in: the directory deleted by hand already.
    const outcome = await resetProject(p);
    expect(outcome.ok).toBe(true);
    expect(outcome.removed).toEqual([]);
  });
});
