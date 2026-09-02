// The judge only compares against a hand-off if the manifest actually carries
// it, so the prompt wiring is worth pinning. Composed from the shipped
// judge-core skill rather than a stand-in string: the instruction to read the
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

describe("the batch header says what is in front of the judge", () => {
  const six = (["desktop", "tablet", "phone"] as const).flatMap((formFactor) =>
    (["dark", "light"] as const).map((scheme) => ({
      ...base,
      formFactor,
      scheme,
      id: `web/app/root/rest/${formFactor}/${scheme}`,
      route: "/",
      routeName: "root",
      path: `web/app/root/rest--${formFactor}-${scheme}.png`,
    })),
  );

  test("a full view reads as every form factor and both schemes", () => {
    const prompt = buildJudgePrompt(rubric.text, "p", six, "/ev");
    expect(prompt).toContain("formFactors: desktop, tablet, phone\nschemes: dark, light");
    expect(prompt).not.toContain("(not captured:");
    expect(prompt.indexOf("=== SHOTS")).toBeLessThan(prompt.indexOf("formFactors:"));
    expect(prompt.indexOf("formFactors:")).toBeLessThan(prompt.indexOf("- shotId:"));
  });

  test("a narrowed batch names the form factors and schemes it lacks", () => {
    const two = six.filter((s) => s.scheme === "dark" && s.formFactor !== "tablet");
    const prompt = buildJudgePrompt(rubric.text, "p", two, "/ev");
    expect(prompt).toContain("formFactors: desktop, phone (not captured: tablet)");
    expect(prompt).toContain("schemes: dark (not captured: light)");
  });

  test("a tall shot's pieces are named under it when the caller cut them", () => {
    const tall = { ...six[0]!, height: 11202 };
    const pieces = new Map([[tall.id, ["web/app/root/rest--desktop-dark.p1of2.png", "web/app/root/rest--desktop-dark.p2of2.png"]]]);
    const prompt = buildJudgePrompt(rubric.text, "p", [tall], "/ev", { pieces });
    expect(prompt).toContain("read these 2 pieces top to bottom instead");
    expect(prompt).toContain("/ev/web/app/root/rest--desktop-dark.p2of2.png  (piece 2 of 2)");
  });
});

describe("the rubric reads the batch header", () => {
  test("each form factor is judged as its own rendering, and the comparison follows the header", () => {
    const prompt = buildJudgePrompt(rubric.text, "p", [], "/ev");
    expect(prompt).toContain("Every form factor is a rendering of its own");
    expect(prompt).toContain("Judge each form factor, or each device, as its own rendering first");
    expect(prompt).toContain("across the form\n   factors the header lists");
    expect(prompt).toContain("Say\n   nothing about a form factor the header marks as not captured");
    expect(prompt).toContain("What a device shot (iOS, Android) must do");
  });
});

describe("the accessibility tree in the manifest", () => {
  const shots: ShotRecord[] = [
    { ...base, id: "dark", route: "/a", routeName: "/a", path: "a.png" },
    { ...base, id: "light", scheme: "light", route: "/a", routeName: "/a", path: "b.png" },
    { ...base, id: "other", route: "/c", routeName: "/c", path: "c.png" },
  ];
  const tree = '- banner:\n  - heading "Dashboard" [level=1]\n- button "Save"';

  test("a shot's tree is carried under its own line, indented", () => {
    const prompt = buildJudgePrompt(rubric.text, "proj", shots, "/ev", {
      aria: new Map([["dark", { yaml: tree, hash: "t1" }]]),
    });
    expect(prompt).toContain("  aria: |");
    expect(prompt).toContain('    - heading "Dashboard" [level=1]');
  });

  test("a repeat of the same tree names the shot that carried it", () => {
    // A view group is one page at several sizes and schemes, so its members
    // usually share a tree. Six copies would crowd out the images.
    const prompt = buildJudgePrompt(rubric.text, "proj", shots, "/ev", {
      aria: new Map([
        ["dark", { yaml: tree, hash: "t1" }],
        ["light", { yaml: tree, hash: "t1" }],
      ]),
    });
    expect(prompt).toContain("aria: same tree as dark");
    expect(prompt.match(/aria: \|/g)).toHaveLength(1);
  });

  test("a different tree is carried in full, not deduplicated", () => {
    const prompt = buildJudgePrompt(rubric.text, "proj", shots, "/ev", {
      aria: new Map([
        ["dark", { yaml: tree, hash: "t1" }],
        ["other", { yaml: '- button "Cancel"', hash: "t2" }],
      ]),
    });
    expect(prompt.match(/aria: \|/g)).toHaveLength(2);
    expect(prompt).toContain('    - button "Cancel"');
  });

  test("a shot with no tree promises none, and no placeholder survives", () => {
    const prompt = buildJudgePrompt(rubric.text, "proj", shots, "/ev", {
      aria: new Map([["dark", { yaml: tree, hash: "t1" }]]),
    });
    const otherLine = prompt.split("\n").find((l) => l.includes("shotId: other"));
    expect(otherLine).toBeDefined();
    expect(prompt).not.toContain("{{");
  });

  test("no trees at all leaves the manifest exactly as it was", () => {
    expect(buildJudgePrompt(rubric.text, "proj", shots, "/ev", { aria: new Map() })).toBe(
      buildJudgePrompt(rubric.text, "proj", shots, "/ev"),
    );
  });
});
