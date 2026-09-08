// Two captures of the same view that came out byte-identical.
//
// The distinction this file guards: that is a defect when the project ships two
// schemes and the switch did nothing, and it is nothing at all when the project
// ships one scheme and lookout photographed it twice. Before `schemes` existed
// lookout could not tell those apart, so it filed the finding against every
// single-scheme project on every route. The check itself needs both shots
// present, so declaring one scheme closes it structurally rather than by a
// special case here.
import { describe, expect, test } from "bun:test";
import { markSchemeMismatches } from "../src/capture/web-page.js";
import type { ShotRecord } from "../src/types.js";

const shot = (over: Partial<ShotRecord>): ShotRecord => ({
  id: `web/app/root/rest/desktop/${over.scheme ?? "dark"}`,
  target: "app",
  route: "/",
  routeName: "root",
  state: "rest",
  platform: "web",
  formFactor: "desktop",
  scheme: "dark",
  path: `web/app/root/rest--desktop-${over.scheme ?? "dark"}.png`,
  hash: "h1",
  bytes: 1,
  width: 2880,
  height: 1800,
  animated: false,
  capturedAt: "t",
  runId: "r",
  deterministicFindings: [],
  ...over,
});

function findingsOf(shots: ShotRecord[]): string[] {
  return shots.flatMap((s) => s.deterministicFindings.map((f) => f.type));
}

describe("markSchemeMismatches", () => {
  test("files when both schemes were photographed and came out identical", () => {
    const shots = [
      shot({ scheme: "dark", hash: "same" }),
      shot({ scheme: "light", hash: "same" }),
    ];
    markSchemeMismatches(shots);
    expect(findingsOf(shots)).toEqual(["scheme-mismatch"]);
    // Filed on the light shot, so it lands once per view rather than twice.
    expect(shots[0]!.deterministicFindings).toEqual([]);
  });

  test("says nothing when the two schemes actually differ", () => {
    const shots = [
      shot({ scheme: "dark", hash: "d" }),
      shot({ scheme: "light", hash: "l" }),
    ];
    markSchemeMismatches(shots);
    expect(findingsOf(shots)).toEqual([]);
  });

  test("says nothing about a project that ships one scheme", () => {
    // The run this produces: schemes: ["dark"] declared, so the walk never
    // took a light shot and there is no pair to compare. This is the false
    // alarm the declaration exists to prevent.
    const shots = [shot({ scheme: "dark", hash: "same" })];
    markSchemeMismatches(shots);
    expect(findingsOf(shots)).toEqual([]);
  });

  test("compares within a view, not across views", () => {
    // Two form factors that each render identically in both schemes are two
    // findings, not one, because they are two views with the same defect.
    const shots = [
      shot({ formFactor: "desktop", scheme: "dark", hash: "a" }),
      shot({ formFactor: "desktop", scheme: "light", hash: "a" }),
      shot({ formFactor: "phone", scheme: "dark", hash: "b" }),
      shot({ formFactor: "phone", scheme: "light", hash: "b" }),
    ];
    markSchemeMismatches(shots);
    expect(findingsOf(shots)).toEqual(["scheme-mismatch", "scheme-mismatch"]);
  });

  test("names both causes, since the reader cannot tell which it is", () => {
    const shots = [
      shot({ scheme: "dark", hash: "same" }),
      shot({ scheme: "light", hash: "same" }),
    ];
    markSchemeMismatches(shots);
    const message = shots[1]!.deterministicFindings[0]!.message;
    expect(message).toContain("scheme");
    expect(message).toContain("ships one scheme");
  });
});
