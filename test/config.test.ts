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
