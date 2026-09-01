// The judge only compares against a hand-off if the manifest actually carries
// it, so the prompt wiring is worth pinning. Composed from the shipped
// visual-judge skill rather than a stand-in string: the instruction to read the
// hand-off lives in that file now, and a test that passed its own text would
// pass whatever the file said.
import { describe, expect, test } from "bun:test";
import { buildJudgePrompt } from "../src/judge/engine.js";
import { loadRubric } from "../src/judge/rubric.js";
import { tmpProject } from "./tmp-project.js";
import type { ShotRecord } from "../src/types.js";

const project = () => tmpProject("lookout-judge-prompt-");

const rubric = await loadRubric(project());

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
  const prompt = buildJudgePrompt(rubric.text, "proj", shots, "/ev");

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

  test("carries the rubric the judge is asked to apply", () => {
    expect(prompt).toContain("## Category vocabulary");
    expect(prompt).toContain("## Output contract");
  });

  test("names the project it is judging", () => {
    expect(prompt).toContain('the project "proj"');
  });

  test("carries the region vocabulary the contract now demands", () => {
    expect(prompt).toContain("## Region vocabulary");
    expect(prompt).toContain('"region"');
  });
});

describe("the ALREADY FILED aid travels", () => {
  const shots: ShotRecord[] = [
    { ...base, id: "here", route: "/b", routeName: "/b", path: "b.png" },
  ];

  test("a local prior needs its shot in the batch", () => {
    const prompt = buildJudgePrompt(rubric.text, "proj", shots, "/ev", {
      prior: [{ shotId: "elsewhere", category: "contrast", attribute: "body-text", title: "t" }],
    });
    expect(prompt).not.toContain("ALREADY FILED");
  });

  test("a shell prior reaches every batch, shot or no shot", () => {
    const prompt = buildJudgePrompt(rubric.text, "proj", shots, "/ev", {
      prior: [
        {
          shotId: "*",
          category: "layout-overflow",
          attribute: "header-avatar-clipped",
          title: "Avatar clipped in the top bar",
          region: "shell-header",
        },
      ],
    });
    expect(prompt).toContain("ALREADY FILED");
    expect(prompt).toContain("Also open elsewhere in this application");
    expect(prompt).toContain("shell-header  [layout-overflow/header-avatar-clipped]");
  });
});
