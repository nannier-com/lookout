// A shot the judge called clean without opening it is not clean. The stream
// records every Read the model made; a clean claim about a file it never
// asked for is downgraded to "nobody ruled on this", left out of the cache,
// and judged again next run.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeBatch } from "../src/judge/engine.js";
import { ReplyStream } from "../src/judge/stream.js";
import { wasRead } from "../src/judge/manifest.js";
import type { ShotRecord } from "../src/types.js";
import "./setup.js";

const MOCK = join(import.meta.dir, "mock-claude.ts");

const shot = (formFactor: ShotRecord["formFactor"]): ShotRecord => ({
  id: `web/app/root/rest/${formFactor}/dark`,
  target: "app",
  route: "/",
  routeName: "root",
  state: "rest",
  platform: "web",
  formFactor,
  scheme: "dark",
  path: `web/app/root/rest--${formFactor}-dark.png`,
  hash: "h",
  bytes: 1,
  width: 10,
  height: 10,
  animated: false,
  capturedAt: "t",
  runId: "r",
  deterministicFindings: [],
});

const SKILL = "judge\n=== SHOTS ({{shotCount}}) ===\n{{manifest}}\n=== END SHOTS ===\n{{project}}{{handoff}}{{priorFindings}}";

let evDir = "";
beforeEach(() => {
  evDir = mkdtempSync(join(tmpdir(), "lookout-unread-"));
  process.env.LOOKOUT_CLAUDE_BIN = MOCK;
  process.env.MOCK_MODE = "judge";
});
afterEach(() => {
  rmSync(evDir, { recursive: true, force: true });
  delete process.env.LOOKOUT_CLAUDE_BIN;
  delete process.env.MOCK_MODE;
  delete process.env.MOCK_JUDGE_READS;
});

describe("the stream keeps every Read", () => {
  test("all of them, from every turn, whether or not anybody is narrating", () => {
    const s = new ReplyStream();
    const turn = (files: string[]) =>
      JSON.stringify({
        type: "assistant",
        message: { content: files.map((f) => ({ type: "tool_use", name: "Read", input: { file_path: f } })) },
      }) + "\n";
    s.push(turn(["/ev/a.png", "/ev/b.png"]));
    s.push(turn(["c.png"]));
    s.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "x" } }] } }) + "\n");
    expect(s.reads).toEqual(["/ev/a.png", "/ev/b.png", "c.png"]);
  });

  test("a shot is read when every file it is read from was opened, spelled either way", () => {
    const desktop = shot("desktop");
    expect(wasRead(desktop, "/ev", undefined, ["/ev/web/app/root/rest--desktop-dark.png"])).toBe(true);
    expect(wasRead(desktop, "/ev", undefined, ["web/app/root/rest--desktop-dark.png"])).toBe(true);
    expect(wasRead(desktop, "/ev", undefined, ["/ev/web/app/root/rest--phone-dark.png"])).toBe(false);
    const pieces = new Map([[desktop.id, ["web/app/root/rest--desktop-dark.p1of2.png", "web/app/root/rest--desktop-dark.p2of2.png"]]]);
    expect(wasRead(desktop, "/ev", pieces, ["/ev/web/app/root/rest--desktop-dark.p1of2.png"])).toBe(false);
    expect(wasRead(desktop, "/ev", pieces, ["/ev/web/app/root/rest--desktop-dark.p1of2.png", "web/app/root/rest--desktop-dark.p2of2.png"])).toBe(true);
  });
});

describe("a clean claim about an unread shot", () => {
  const shots = [shot("desktop"), shot("tablet"), shot("phone")];

  test("stands when the judge opened every shot", async () => {
    const res = await judgeBatch(SKILL, "proj", shots, evDir, "sonnet");
    expect(res.unread).toEqual([]);
    expect(res.unaccounted).toEqual([]);
    // The mock files one finding on the first shot and calls the rest clean.
    expect(res.cleanShotIds.sort()).toEqual([shots[1]!.id, shots[2]!.id].sort());
  });

  test("is no verdict when the judge only opened the desktop shot", async () => {
    process.env.MOCK_JUDGE_READS = "first";
    const res = await judgeBatch(SKILL, "proj", shots, evDir, "sonnet");
    expect(res.unread.sort()).toEqual([shots[1]!.id, shots[2]!.id].sort());
    expect(res.cleanShotIds).toEqual([]);
    expect(res.unaccounted.sort()).toEqual([shots[1]!.id, shots[2]!.id].sort());
    // The finding on the shot it did read still stands.
    expect(res.findings.map((f) => f.shotId)).toContain(shots[0]!.id);
  });
});
