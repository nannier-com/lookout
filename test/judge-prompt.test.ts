// The judge only compares against a hand-off if the manifest actually carries
// it, so the prompt wiring is worth pinning.
import { describe, expect, test } from "bun:test";
import { buildJudgePrompt } from "../src/judge/engine.js";
import type { ShotRecord } from "../src/types.js";

const base: Omit<ShotRecord, "id" | "route" | "routeName" | "path"> = {
  target: "app",
  state: "rest",
  platform: "web",
  formFactor: "desktop",
  scheme: "dark",
  hash: "h",
  bytes: 1,
  width: 10,
  height: 10,
  animated: false,
  capturedAt: "t",
  runId: "r",
  deterministicFindings: [],
};

describe("buildJudgePrompt", () => {
  const shots: ShotRecord[] = [
    { ...base, id: "with", route: "/a", routeName: "/a", path: "a.png", design: "/mocks/a.png" },
    { ...base, id: "without", route: "/b", routeName: "/b", path: "b.png" },
  ];
  const prompt = buildJudgePrompt("RUBRIC", "proj", shots, "/ev");

  test("lists a shot's design hand-off", () => {
    expect(prompt).toContain("design: /mocks/a.png");
  });

  test("tells the judge to read the hand-off too", () => {
    expect(prompt).toContain("design hand-off image: read that too");
  });

  test("adds no design line to a shot without one", () => {
    const withoutBlock = prompt.slice(prompt.indexOf("shotId: without"));
    expect(withoutBlock).not.toContain("design:");
  });
});
