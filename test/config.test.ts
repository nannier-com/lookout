// Pure-function coverage of config validation and target resolution: the
// contract every consumer repo's .lookout/config.ts is held to.
import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config.js";
import { resolveRoutes, resolveTargets } from "../src/targets.js";
import { isLocalUrl, parseFlags } from "../src/util.js";

describe("validateConfig", () => {
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
      "/repo/.lookout/config.ts",
    );
    expect(r!.design).toBe("/repo/.lookout/mocks/x.png");
  });

  test("leaves routes without a design reference undefined", () => {
    const [r] = resolveRoutes(
      { name: "app", url: "http://localhost:1", routes: ["/x"] },
      undefined,
      "/repo/.lookout/config.ts",
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
