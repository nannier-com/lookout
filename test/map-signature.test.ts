// When a map is still a fact about the source. The signature moves when the
// skill, the configured routes, the route-bearing files or the files the
// reader opened move, and stays put when only the model that read changes.
import { describe, expect, test } from "bun:test";
import type { MapCandidate } from "../src/map/candidates.js";
import { configHash, mapFreshness, mapSignature, skillHash } from "../src/map/signature.js";
import type { MapTarget } from "../src/map/store.js";

const skill = { version: 1, text: "read the source" };
const slice = { url: "http://localhost:3000", routes: [{ path: "/", states: [] }] };
const examined = [
  { path: "src/App.tsx", hash: "aaaa" },
  { path: "src/router.ts", hash: "bbbb" },
];
const candidates: MapCandidate[] = [
  { path: "/repo/src/router.ts", relPath: "src/router.ts", score: 10, marks: ["router"], hash: "bbbb" },
  { path: "/repo/src/App.tsx", relPath: "src/App.tsx", score: 3, marks: ["links"], hash: "aaaa" },
];
const candidatePaths = ["src/App.tsx", "src/router.ts"];

function target(over: Partial<MapTarget> = {}): MapTarget {
  return {
    url: slice.url,
    mappedAt: "t",
    skillVersion: 1,
    ai: "claude-code",
    model: "sonnet",
    signature: mapSignature({ skill, configSlice: slice, candidatePaths, examined }),
    examined,
    candidates: candidatePaths,
    configHash: configHash(slice),
    skillHash: skillHash(skill),
    roots: [],
    skipped: [],
    notes: [],
    ...over,
  };
}

const hashes: Record<string, string | null> = { "src/App.tsx": "aaaa", "src/router.ts": "bbbb" };
const hashOf = (p: string): string | null => hashes[p] ?? null;

describe("mapSignature", () => {
  test("is stable across key order and examined order, and moves with each input", () => {
    const base = mapSignature({ skill, configSlice: slice, candidatePaths, examined });
    expect(mapSignature({ examined: [...examined].reverse(), candidatePaths: [...candidatePaths].reverse(), configSlice: slice, skill })).toBe(base);
    expect(mapSignature({ skill: { version: 2, text: skill.text }, configSlice: slice, candidatePaths, examined })).not.toBe(base);
    expect(mapSignature({ skill: { version: 1, text: "amended" }, configSlice: slice, candidatePaths, examined })).not.toBe(base);
    expect(mapSignature({ skill, configSlice: { ...slice, routes: [...slice.routes, { path: "/new", states: [] }] }, candidatePaths, examined })).not.toBe(base);
    expect(mapSignature({ skill, configSlice: slice, candidatePaths: [...candidatePaths, "src/new.tsx"], examined })).not.toBe(base);
    expect(mapSignature({ skill, configSlice: slice, candidatePaths, examined: [examined[0]!, { path: "src/router.ts", hash: "cccc" }] })).not.toBe(base);
  });
});

describe("mapFreshness", () => {
  test("a map derived from exactly this source is fresh", () => {
    expect(mapFreshness({ target: target(), targetName: "app", skill, configSlice: slice, candidates, hashOf })).toEqual({ fresh: true, reasons: [] });
  });

  test("no map is stale, and says so", () => {
    expect(mapFreshness({ target: undefined, targetName: "app", skill, configSlice: slice, candidates, hashOf })).toEqual({
      fresh: false,
      reasons: ["no map for app"],
    });
  });

  test("an examined file that changed, or is gone, names itself", () => {
    const changed = mapFreshness({ target: target(), targetName: "app", skill, configSlice: slice, candidates, hashOf: (p) => (p === "src/App.tsx" ? "zzzz" : hashOf(p)) });
    expect(changed).toEqual({ fresh: false, reasons: ["1 examined file(s) changed"] });
    const gone = mapFreshness({ target: target(), targetName: "app", skill, configSlice: slice, candidates, hashOf: (p) => (p === "src/router.ts" ? null : hashOf(p)) });
    expect(gone.reasons).toEqual(["1 examined file(s) gone"]);
  });

  test("a route-bearing file added or removed stales the map even when nothing examined changed", () => {
    const more = [...candidates, { path: "/repo/src/pages/new.tsx", relPath: "src/pages/new.tsx", score: 20, marks: ["route /new"], hash: "dddd" }];
    const f = mapFreshness({ target: target(), targetName: "app", skill, configSlice: slice, candidates: more, hashOf });
    expect(f).toEqual({ fresh: false, reasons: ["1 route-bearing file(s) added or removed"] });
  });

  test("configured routes moving, and the skill moving, each name themselves", () => {
    const routes = mapFreshness({ target: target(), targetName: "app", skill, configSlice: { ...slice, routes: [] }, candidates, hashOf });
    expect(routes.reasons).toEqual(["configured routes changed"]);
    const version = mapFreshness({ target: target(), targetName: "app", skill: { version: 2, text: skill.text }, configSlice: slice, candidates, hashOf });
    expect(version.reasons).toEqual(["map-screens v1 -> v2"]);
    const text = mapFreshness({ target: target(), targetName: "app", skill: { version: 1, text: "amended" }, configSlice: slice, candidates, hashOf });
    expect(text.reasons).toEqual(["the map-screens skill changed"]);
  });

  test("the model that read is not part of the signature", () => {
    const f = mapFreshness({ target: target({ model: "another-model", ai: "codex" }), targetName: "app", skill, configSlice: slice, candidates, hashOf });
    expect(f.fresh).toBe(true);
  });

  test("a map written without the component hashes still decides by the composite", () => {
    const older = target({ candidates: undefined, configHash: undefined, skillHash: undefined });
    expect(mapFreshness({ target: older, targetName: "app", skill, configSlice: slice, candidates, hashOf }).fresh).toBe(true);
    const moved = mapFreshness({ target: older, targetName: "app", skill: { version: 1, text: "amended" }, configSlice: slice, candidates, hashOf });
    expect(moved).toEqual({ fresh: false, reasons: ["the map's signature no longer matches"] });
  });
});
