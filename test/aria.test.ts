// The accessibility tree beside a shot.
//
// It is the first evidence lookout gives a judge that is not an image, so the
// two things these hold are that it stays small enough to sit in a prompt
// beside several screenshots, and that when it is cut short it says so in the
// text the model reads rather than only in the record.
import { describe, expect, test } from "bun:test";
import {
  ARIA_VERSION,
  MAX_LINE_CHARS,
  MAX_PROMPT_LINES,
  buildAriaSidecar,
  parseAriaSidecar,
  promptTree,
  trimAria,
} from "../src/capture/aria.js";

const shot = { id: "web/app/root/rest/desktop/dark", runId: "r1", capturedAt: "t1", hash: "pnghash" };

describe("trimAria", () => {
  test("a small tree comes back untouched and unmarked", () => {
    const yaml = '- banner:\n  - heading "Dashboard" [level=1]\n- main:\n  - button "Save"';
    const out = trimAria(yaml, 50);
    expect(out.yaml).toBe(yaml);
    expect(out.lines).toBe(4);
    expect(out.truncated).toBe(false);
  });

  test("a line longer than the cap is cut, not dropped", () => {
    const long = `- text: ${"x".repeat(400)}`;
    const out = trimAria(long, 50);
    expect(out.yaml.length).toBe(MAX_LINE_CHARS + 3);
    expect(out.yaml.endsWith("...")).toBe(true);
    expect(out.truncated).toBe(false);
  });

  test("collapsing is idempotent: trimming a trimmed tree keeps the real count", () => {
    // The tree is trimmed twice, once to the stored budget and again to the
    // smaller prompt budget. A marker the text-run detector matched made the
    // second pass count its own marker as copy and replace the real number.
    const yaml = ["- main:", ...Array.from({ length: 20 }, (_, i) => `  - text: paragraph ${i}`)].join("\n");
    const once = trimAria(yaml, 100);
    const twice = trimAria(once.yaml, 100);
    expect(twice.yaml).toBe(once.yaml);
    expect(twice.yaml).toContain("17 more text line(s) not shown");
  });

  test("a collapsed run marks its loss at the run's own depth, even at the tail", () => {
    // Indentation is the only depth signal inside a YAML block scalar, so a
    // marker flushed at column 0 reads as a text node of the page root.
    const yaml = ["- main:", ...Array.from({ length: 9 }, (_, i) => `    - text: line ${i}`)].join("\n");
    const out = trimAria(yaml, 100);
    const marker = out.yaml.split("\n").find((l) => l.includes("not shown"))!;
    expect(marker.startsWith("    #")).toBe(true);
  });

  test("re-trimming carries an earlier pass's loss into the new count", () => {
    const yaml = Array.from({ length: 400 }, (_, i) => `- button "b${i}"`).join("\n");
    const stored = trimAria(yaml, 300);
    const shown = trimAria(stored.yaml, 120);
    const said = Number(/(\d+) more line/.exec(shown.yaml)![1]);
    // 119 shown, 281 genuinely absent from the page. The old code said 181.
    expect(shown.yaml.split("\n")).toHaveLength(120);
    expect(said).toBe(400 - 119);
  });

  test("a wall of copy collapses to its first few, counting the rest", () => {
    const yaml = ["- main:", ...Array.from({ length: 20 }, (_, i) => `  - text: paragraph ${i}`), "- button \"Save\""].join("\n");
    const out = trimAria(yaml, 100);
    expect(out.yaml).toContain("- text: paragraph 0");
    expect(out.yaml).toContain("- text: paragraph 2");
    expect(out.yaml).not.toContain("- text: paragraph 9");
    expect(out.yaml).toContain("17 more text line(s) not shown");
    expect(out.yaml).toContain('- button "Save"');
  });

  test("over the budget, the cut is the last line so the model reads it", () => {
    const yaml = Array.from({ length: 40 }, (_, i) => `- button "b${i}"`).join("\n");
    const out = trimAria(yaml, 10);
    expect(out.lines).toBe(10);
    expect(out.truncated).toBe(true);
    const lines = out.yaml.split("\n");
    expect(lines[lines.length - 1]).toBe("# ... 31 more line(s) not shown");
  });

  test("what the cut says adds up to the whole tree", () => {
    const yaml = Array.from({ length: 40 }, (_, i) => `- button "b${i}"`).join("\n");
    const out = trimAria(yaml, 10);
    const shown = out.yaml.split("\n").length - 1;
    const said = Number(/(\d+) more/.exec(out.yaml)![1]);
    expect(shown + said).toBe(40);
  });
});

describe("the sidecar", () => {
  test("carries the shot it describes and the hash of what it holds", () => {
    const s = buildAriaSidecar('- button "Save"', shot, null);
    expect(s.version).toBe(ARIA_VERSION);
    expect(s.shotId).toBe(shot.id);
    expect(s.shotHash).toBe("pnghash");
    expect(s.origin).toBe("document");
    expect(s.scope).toBeNull();
    expect(s.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("an element-framed shot records the selector it was taken of", () => {
    const s = buildAriaSidecar('- button "Save"', shot, "#root");
    expect(s.origin).toBe("element");
    expect(s.scope).toBe("#root");
  });

  test("the hash follows the trimmed text, so a longer page keys differently", () => {
    const a = buildAriaSidecar('- button "Save"', shot, null);
    const b = buildAriaSidecar('- button "Cancel"', shot, null);
    expect(a.hash).not.toBe(b.hash);
  });

  test("a sidecar from another version is not read", () => {
    const s = buildAriaSidecar('- button "Save"', shot, null);
    expect(parseAriaSidecar(JSON.stringify(s))!.shotId).toBe(shot.id);
    expect(parseAriaSidecar(JSON.stringify({ ...s, version: 99 }))).toBeNull();
    expect(parseAriaSidecar("not json")).toBeNull();
  });
});

describe("promptTree", () => {
  test("the stored tree is trimmed again to the prompt's smaller budget", () => {
    const yaml = Array.from({ length: 250 }, (_, i) => `- button "b${i}"`).join("\n");
    const s = buildAriaSidecar(yaml, shot, null);
    expect(s.lines).toBe(250);
    const forPrompt = promptTree(s);
    expect(forPrompt.split("\n")).toHaveLength(MAX_PROMPT_LINES);
    expect(forPrompt.endsWith("not shown")).toBe(true);
  });
});
