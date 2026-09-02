// The per-form-factor tally: the line that says whether the phone shots were
// judged at all, which "12 judged" never did.
import { describe, expect, test } from "bun:test";
import { tallyFormFactors, tallyLines } from "../src/check/tally.js";
import type { ShotRecord } from "../src/types.js";

const shot = (id: string, formFactor: ShotRecord["formFactor"], platform: ShotRecord["platform"] = "web"): ShotRecord => ({
  id,
  target: "app",
  route: "/",
  routeName: "root",
  state: "rest",
  platform,
  formFactor,
  scheme: "dark",
  path: `${id}.png`,
  hash: "h",
  bytes: 1,
  width: 1,
  height: 1,
  animated: false,
  capturedAt: "t",
  runId: "r",
  deterministicFindings: [],
});

describe("tallyFormFactors", () => {
  const shots = [
    shot("d1", "desktop"),
    shot("d2", "desktop"),
    shot("t1", "tablet"),
    shot("p1", "phone"),
    shot("p2", "phone"),
    shot("i1", "phone", "ios"),
  ];

  test("counts per platform and form factor, in walk order, skipping empty combinations", () => {
    const tally = tallyFormFactors(shots, new Set(["d1", "t1", "p1", "i1"]), new Set(["d1", "p2"]), new Set(["p1"]));
    expect(tally.map((t) => `${t.platform}/${t.formFactor}`)).toEqual(["web/desktop", "web/tablet", "web/phone", "ios/phone"]);
    expect(tally[0]).toEqual({ platform: "web", formFactor: "desktop", shots: 2, judged: 1, cached: 1, withFindings: 1, unjudged: 0 });
    expect(tally[2]).toEqual({ platform: "web", formFactor: "phone", shots: 2, judged: 1, cached: 1, withFindings: 1, unjudged: 1 });
  });

  test("the lines name every form factor, and say which ones were not judged", () => {
    const tally = tallyFormFactors(shots, new Set(["d1", "d2", "t1", "p1", "p2", "i1"]), new Set(), new Set(["p1", "p2"]));
    const lines = tallyLines(tally);
    expect(lines[0]).toBe(
      "web: desktop 2 shot(s), 2 judged, 0 cached, 0 with findings; tablet 1 shot(s), 1 judged, 0 cached, 0 with findings; phone 2 shot(s), 2 judged, 0 cached, 0 with findings",
    );
    expect(lines[1]).toBe("web: NOT judged: phone 2 of 2 (a shot nobody ruled on is not clean; judged again next run)");
    expect(lines[2]).toStartWith("ios: phone 1 shot(s)");
    expect(lines).toHaveLength(3);
  });
});
