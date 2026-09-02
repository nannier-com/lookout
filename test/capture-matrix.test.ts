// The capture matrix: the defaults every verb walks, and what a flag does to
// them. Pinned as literals rather than against the constants they come from,
// so a change to the set is a change to this file too.
import { describe, expect, test } from "bun:test";
import { defaultPlatforms, resolveFormFactors, resolvePlatforms, resolveSchemes } from "../src/capture/matrix.js";
import { DEFAULT_VIEWPORTS, FORM_FACTORS, PLATFORMS, SCHEMES } from "../src/types.js";
import type { ProjectKind } from "../src/project-kind.js";

const kind = (over: Partial<ProjectKind>): ProjectKind => ({
  web: true,
  native: [],
  suggested: [],
  evidence: [],
  declared: false,
  ...over,
});

describe("form factors", () => {
  test("every form factor by default, widest first", () => {
    expect(resolveFormFactors(undefined)).toEqual(["desktop", "tablet", "phone"]);
    expect(resolveFormFactors(false)).toEqual(["desktop", "tablet", "phone"]);
  });

  test("a flag narrows, and the walk order is the set's, not the flag's", () => {
    expect(resolveFormFactors("phone,desktop")).toEqual(["desktop", "phone"]);
    expect(resolveFormFactors("phone, phone")).toEqual(["phone"]);
    expect(resolveFormFactors("tablet")).toEqual(["tablet"]);
  });

  test("a value outside the set is answered with the set", () => {
    expect(() => resolveFormFactors("watch")).toThrow(/unknown viewport "watch" \(desktop \| tablet \| phone\)/);
  });

  test("the presets and the set agree, and the first form factor is the widest", () => {
    expect(([...FORM_FACTORS] as string[]).sort()).toEqual(Object.keys(DEFAULT_VIEWPORTS).sort());
    const widest = Math.max(...Object.values(DEFAULT_VIEWPORTS).map((v) => v.width));
    expect(DEFAULT_VIEWPORTS[FORM_FACTORS[0]!].width).toBe(widest);
  });
});

describe("schemes", () => {
  test("both by default, dark first; a flag narrows; an unknown one is refused", () => {
    expect(resolveSchemes(undefined)).toEqual(["dark", "light"]);
    expect(resolveSchemes("light")).toEqual(["light"]);
    expect(resolveSchemes("light,dark")).toEqual(["dark", "light"]);
    expect(() => resolveSchemes("sepia")).toThrow(/unknown scheme "sepia" \(dark \| light\)/);
    expect([...SCHEMES]).toEqual(["dark", "light"]);
  });
});

describe("platforms", () => {
  test("the web fold walks web, the device fold walks its devices, both walk both", () => {
    expect(defaultPlatforms(kind({ web: true }))).toEqual(["web"]);
    expect(defaultPlatforms(kind({ web: false, native: ["ios", "android"] }))).toEqual(["ios", "android"]);
    expect(defaultPlatforms(kind({ web: true, native: ["ios"] }))).toEqual(["web", "ios"]);
    expect(resolvePlatforms(undefined, kind({ web: false, native: ["android"] }))).toEqual(["android"]);
  });

  test("a flag decides outright, in the set's order, and an unknown platform is refused", () => {
    expect(resolvePlatforms("android,web", kind({ web: true }))).toEqual(["web", "android"]);
    expect(resolvePlatforms("ios", kind({ web: true }))).toEqual(["ios"]);
    expect(() => resolvePlatforms("windows", kind({ web: true }))).toThrow(/unknown platform "windows" \(web \| ios \| android\)/);
    expect([...PLATFORMS]).toEqual(["web", "ios", "android"]);
  });
});
