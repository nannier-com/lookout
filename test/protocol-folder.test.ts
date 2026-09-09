// `lookout protocol` describes the issue folder and the working evidence. It
// is read by agents on any harness, so it has to name every file the folder
// actually holds and the one convention the workspace relies on.
import { describe, expect, test } from "bun:test";
import { protocolText } from "../src/verbs/protocol.js";
import { ISSUE_DOC_FILE, ISSUE_RECORD_FILE } from "../src/issues/paths.js";

describe("the protocol names what is on disk", () => {
  const text = protocolText();

  test("every file the issue folder holds", () => {
    for (const name of [ISSUE_DOC_FILE, ISSUE_RECORD_FILE, "state.json", "frames.json", "img/pre/", "img/post/", "handoff.command"]) {
      expect({ name, named: text.includes(name) }).toEqual({ name, named: true });
    }
  });

  test("the screen map and the walk, so an agent reads the source before it captures", () => {
    expect(text).toContain("lookout map");
    expect(text).toContain("map.json");
    expect(text).toContain("one screen at a time");
    expect(text).toContain("--replay-only");
  });

  test("what a capture photographs, in either fold, and what narrowing a ruling costs", () => {
    expect(text).toContain("desktop, tablet and phone");
    expect(text).toContain("booted iOS and Android devices");
    expect(text).toContain("--viewports");
    expect(text).toContain("ruled not verifiable");
  });

  test("where the working evidence is, and the sidecar beside every shot", () => {
    expect(text).toContain(".lookout/workspace/");
    expect(text).toContain("capture-report.json");
    expect(text).toContain("judge-report.json");
    expect(text).toContain("events.jsonl");
    expect(text).toContain(".png.provenance.json");
    expect(text).toContain("shotHash");
  });

  test("what a ruling costs and what it is measured against, without giving orders", () => {
    // The text is wrapped at 76 columns, so phrases are matched within one line.
    expect(text).toContain("A ruling that does not pass spends one of the issue's");
    expect(text).toContain("does not");
    expect(text).toContain("move that baseline");
    expect(text).toContain("--status open");
    expect(text).toContain("no attempt is spent");
    expect(text).toContain("`--commit` may be left out");
    expect(text.toLowerCase()).not.toContain("you must");
  });
});
