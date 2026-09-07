// Pure-function coverage of config validation and target resolution: the
// contract every consumer repo's lookout.config.ts is held to.
import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config.js";
import { resolveRoutes, resolveTargets } from "../src/targets.js";
import { isLocalUrl, parseFlags } from "../src/util.js";

describe("validateConfig", () => {
  test("shellScoping is an optional boolean and nothing else", () => {
    const t = [{ name: "app", url: "http://localhost:1" }];
    expect(validateConfig({ targets: t, shellScoping: true }, "t").shellScoping).toBe(true);
    expect(validateConfig({ targets: t }, "t").shellScoping).toBeUndefined();
    expect(() => validateConfig({ targets: t, shellScoping: "yes" }, "t")).toThrow(/shellScoping/);
  });

  test("provenance is an optional boolean, at the top level and per route", () => {
    const t = [{ name: "app", url: "http://localhost:1" }];
    // The key must survive the validator's whitelist, or `provenance: false`
    // would be silently dropped and the walk would run anyway.
    expect(validateConfig({ targets: t, provenance: false }, "t").provenance).toBe(false);
    expect(validateConfig({ targets: t }, "t").provenance).toBeUndefined();
    expect(() => validateConfig({ targets: t, provenance: "yes" }, "t")).toThrow(/provenance/);
    const routed = [{ name: "app", url: "http://localhost:1", routes: [{ path: "/", provenance: false }] }];
    expect(validateConfig({ targets: routed }, "t").targets[0]!.routes![0]).toMatchObject({
      provenance: false,
    });
    const bad = [{ name: "app", url: "http://localhost:1", routes: [{ path: "/", provenance: "no" }] }];
    expect(() => validateConfig({ targets: bad }, "t")).toThrow(/provenance/);
  });

  test("a route's provenance opt-out survives resolution", () => {
    const routes = resolveRoutes({
      name: "app",
      url: "http://localhost:1",
      routes: [{ path: "/a", provenance: false }, "/b"],
    });
    expect(routes[0]!.provenance).toBe(false);
    expect(routes[1]!.provenance).toBeUndefined();
  });

  test("accepts a minimal config and normalizes the url", () => {
    const c = validateConfig({ targets: [{ name: "app", url: "http://localhost:3000/" }] }, "t");
    expect(c.targets[0]!.url).toBe("http://localhost:3000");
  });

  test("rejects a missing targets array", () => {
    expect(() => validateConfig({}, "t")).toThrow(/targets/);
  });

  test("rejects duplicate target names", () => {
    expect(() =>
      validateConfig(
        { targets: [{ name: "a", url: "http://localhost:1" }, { name: "a", url: "http://localhost:2" }] },
        "t",
      ),
    ).toThrow(/duplicate/);
  });

  test("rejects duplicate routes after leading-slash normalization", () => {
    expect(() =>
      validateConfig(
        { targets: [{ name: "app", url: "http://localhost:1", routes: ["settings", "/settings"] }] },
        "t",
      ),
    ).toThrow(/duplicate/);
  });

  test("accepts a signIn function and rejects a non-function", () => {
    const signIn = async () => {};
    const c = validateConfig(
      { targets: [{ name: "app", url: "http://localhost:1", signIn }] },
      "t",
    );
    expect(c.targets[0]!.signIn).toBe(signIn);
    expect(() =>
      validateConfig({ targets: [{ name: "app", url: "http://localhost:1", signIn: "yes" }] }, "t"),
    ).toThrow(/signIn/);
  });

  test("navigation block: booleans, non-negative caps, string lists", () => {
    const t = [{ name: "app", url: "http://localhost:1" }];
    const c = validateConfig(
      { targets: t, navigation: { enabled: true, maxStatesPerRoute: 5, exclude: ["Sign out"] } },
      "t",
    );
    expect(c.navigation?.enabled).toBe(true);
    expect(validateConfig({ targets: t }, "t").navigation).toBeUndefined();
    expect(() => validateConfig({ targets: t, navigation: { enabled: "yes" } }, "t")).toThrow(/navigation\.enabled/);
    expect(() => validateConfig({ targets: t, navigation: { maxStatesPerRoute: -1 } }, "t")).toThrow(/maxStatesPerRoute/);
    // The indicator caps take the same shape and so must take the same check:
    // an unvalidated "abc" reaches both the planner's prompt and slice(0, NaN),
    // which turns the advertised feature silently off.
    expect(() => validateConfig({ targets: t, navigation: { maxFocusStatesPerRoute: -1 } }, "t")).toThrow(/maxFocusStatesPerRoute/);
    expect(() => validateConfig({ targets: t, navigation: { maxHoverStatesPerRoute: "abc" } }, "t")).toThrow(/maxHoverStatesPerRoute/);
    expect(validateConfig({ targets: t, navigation: { maxFocusStatesPerRoute: 0, maxHoverStatesPerRoute: 2 } }, "t").navigation?.maxHoverStatesPerRoute).toBe(2);
    expect(() => validateConfig({ targets: t, navigation: { exclude: [1] } }, "t")).toThrow(/navigation\.exclude/);
  });

  test("route fields are validated, not cast through", () => {
    const route = (r: unknown) =>
      validateConfig({ targets: [{ name: "app", url: "http://localhost:1", routes: [r] }] }, "t");
    expect(route({ path: "/", states: ["menu-open"], navigation: false })).toBeTruthy();
    expect(() => route({ path: "/", states: [42] })).toThrow(/states/);
    expect(() => route({ path: "/", name: 3 })).toThrow(/name/);
    expect(() => route({ path: "/", element: {} })).toThrow(/element/);
    expect(() => route({ path: "/", navigation: "on" })).toThrow(/navigation/);
  });

  test("rejects a bad scheme mode and an unknown viewport key", () => {
    expect(() =>
      validateConfig({ targets: [{ name: "a", url: "http://localhost:1" }], scheme: { mode: "x" } }, "t"),
    ).toThrow(/scheme/);
    expect(() =>
      validateConfig(
        { targets: [{ name: "a", url: "http://localhost:1" }], viewports: { watch: { width: 1, height: 1 } } },
        "t",
      ),
    ).toThrow(/form factor/);
  });

  test("the checks knob is validated and carried through", () => {
    const ok = validateConfig(
      {
        targets: [{ name: "a", url: "http://localhost:1" }],
        checks: { edgeClip: { ignore: [".carousel__track"] } },
      },
      "t",
    );
    expect(ok.checks?.edgeClip?.ignore).toEqual([".carousel__track"]);
    // A knob shaped wrongly fails loudly: silently ignoring it would mean a
    // project believing it had exempted something that was still measured.
    expect(() =>
      validateConfig({ targets: [{ name: "a", url: "http://localhost:1" }], checks: "yes" }, "t"),
    ).toThrow(/checks/);
    expect(() =>
      validateConfig(
        { targets: [{ name: "a", url: "http://localhost:1" }], checks: { edgeClip: { ignore: "one" } } },
        "t",
      ),
    ).toThrow(/edgeClip\.ignore/);
  });
});

describe("design hand-off references", () => {
  test("resolves a route's design path relative to the config file", () => {
    const [r] = resolveRoutes(
      { name: "app", url: "http://localhost:1", routes: [{ path: "/x", design: "mocks/x.png" }] },
      undefined,
      "/repo/lookout.config.ts",
    );
    expect(r!.design).toBe("/repo/mocks/x.png");
  });

  test("leaves routes without a design reference undefined", () => {
    const [r] = resolveRoutes(
      { name: "app", url: "http://localhost:1", routes: ["/x"] },
      undefined,
      "/repo/lookout.config.ts",
    );
    expect(r!.design).toBeUndefined();
  });

  test("rejects a non-string design reference", () => {
    expect(() =>
      validateConfig(
        { targets: [{ name: "app", url: "http://localhost:1", routes: [{ path: "/x", design: 7 }] }] },
        "t",
      ),
    ).toThrow(/design/);
  });
});

describe("resolveRoutes / resolveTargets", () => {
  const config = validateConfig(
    {
      targets: [
        { name: "app", url: "http://localhost:3000", routes: ["/settings", { path: "settings/profile", name: "Profile" }] },
        { name: "marketing", url: "http://localhost:3100" },
      ],
    },
    "t",
  );

  test("string routes and object routes normalize; missing routes default to /", () => {
    const app = resolveRoutes(config.targets[0]!);
    expect(app.map((r) => r.path)).toEqual(["/settings", "/settings/profile"]);
    expect(app[1]!.name).toBe("Profile");
    expect(resolveRoutes(config.targets[1]!)[0]!.url).toBe("http://localhost:3100");
  });

  test("--targets filters and unknown names throw with the known list", () => {
    expect(resolveTargets(config, ["marketing"]).map((t) => t.def.name)).toEqual(["marketing"]);
    try {
      resolveTargets(config, ["nope"]);
      throw new Error("expected resolveTargets to throw");
    } catch (e) {
      expect((e as Error).message).toMatch(/unknown target "nope"/);
      expect((e as { hint?: string }).hint).toMatch(/app, marketing/);
    }
  });

  test("--routes filter matches by path or name, drops empty targets, rejects total misses", () => {
    const [t] = resolveTargets(config, ["app"], ["Profile"]);
    expect(t!.routes.map((r) => r.path)).toEqual(["/settings/profile"]);
    // A filter that misses one target but hits another drops the miss.
    const across = resolveTargets(config, undefined, ["Profile"]);
    expect(across.map((x) => x.def.name)).toEqual(["app"]);
    expect(() => resolveTargets(config, ["marketing"], ["/nope"])).toThrow(/matched nothing on any/);
  });
});

describe("util", () => {
  test("parseFlags handles =, spaced values, and booleans", () => {
    const p = parseFlags(["--a=1", "--b", "2", "--c", "--d=x,y"]);
    expect(p.flags).toEqual({ a: "1", b: "2", c: true, d: "x,y" });
  });

  test("isLocalUrl accepts localhost forms and rejects everything else", () => {
    expect(isLocalUrl("http://localhost:3000/x")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:2000")).toBe(true);
    expect(isLocalUrl("http://admin.localhost:3000")).toBe(true);
    expect(isLocalUrl("https://example.com")).toBe(false);
  });
});

describe("the native block's device keys", () => {
  const t = [{ name: "app", url: "http://localhost:1" }];
  const ios = { deepLinkScheme: "x", bundleId: "com.x" };

  test("startHint is a string and devices is a non-empty list of phone or tablet", () => {
    const ok = validateConfig({ targets: t, native: { ios: { ...ios, startHint: "make ios-sim", devices: ["phone", "tablet"] } } }, "t");
    expect(ok.native?.ios).toMatchObject({ startHint: "make ios-sim", devices: ["phone", "tablet"] });
    expect(() => validateConfig({ targets: t, native: { ios: { ...ios, startHint: 3 } } }, "t")).toThrow(/native.ios.startHint/);
    expect(() => validateConfig({ targets: t, native: { ios: { ...ios, devices: [] } } }, "t")).toThrow(/native.ios.devices/);
    expect(() => validateConfig({ targets: t, native: { ios: { ...ios, devices: ["watch"] } } }, "t")).toThrow(/native.ios.devices/);
  });

  test("platforms is validated against the set", () => {
    expect(validateConfig({ targets: t, platforms: ["ios", "web", "ios"] }, "t").platforms).toEqual(["ios", "web"]);
    expect(() => validateConfig({ targets: t, platforms: [] }, "t")).toThrow(/platforms/);
    expect(() => validateConfig({ targets: t, platforms: ["windows"] }, "t")).toThrow(/unknown platform "windows"/);
  });
});

describe("direction", () => {
  const t = [{ name: "app", url: "http://localhost:1" }];

  test("a bare string names a preset, normalised to the object form", () => {
    expect(validateConfig({ targets: t, direction: "utility-dense" }, "t").direction).toEqual({ preset: "utility-dense" });
  });

  test("the object form carries a preset, a file, or both", () => {
    expect(validateConfig({ targets: t, direction: { file: "./DESIGN.md" } }, "t").direction).toEqual({ file: "./DESIGN.md" });
    expect(
      validateConfig({ targets: t, direction: { preset: "premium-agency", file: "./DESIGN.md" } }, "t").direction,
    ).toEqual({ preset: "premium-agency", file: "./DESIGN.md" });
    expect(validateConfig({ targets: t }, "t").direction).toBeUndefined();
  });

  test("an unknown preset is refused, naming the ones that exist", () => {
    expect(() => validateConfig({ targets: t, direction: "bauhaus" }, "t")).toThrow(
      "minimalist-editorial | industrial-brutalist | premium-agency | utility-dense",
    );
    expect(() => validateConfig({ targets: t, direction: { preset: "bauhaus" } }, "t")).toThrow(/direction\.preset/);
  });

  test("a file must be a path string, and an empty declaration declares nothing", () => {
    expect(() => validateConfig({ targets: t, direction: { file: 3 } }, "t")).toThrow(/direction\.file/);
    expect(() => validateConfig({ targets: t, direction: {} }, "t")).toThrow(/a preset, a file, or both/);
    expect(() => validateConfig({ targets: t, direction: 7 }, "t")).toThrow(/direction must be/);
  });
});
