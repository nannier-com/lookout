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

describe("resolveRoutes / resolveTargets", () => {
  const config = validateConfig(
    {
      targets: [
        { name: "docs", url: "http://localhost:8081", routes: ["/components/button", { path: "components/badge", name: "Badge" }] },
        { name: "site", url: "http://localhost:2000" },
      ],
    },
    "t",
  );

  test("string routes and object routes normalize; missing routes default to /", () => {
    const docs = resolveRoutes(config.targets[0]!);
    expect(docs.map((r) => r.path)).toEqual(["/components/button", "/components/badge"]);
    expect(docs[1]!.name).toBe("Badge");
    expect(resolveRoutes(config.targets[1]!)[0]!.url).toBe("http://localhost:2000");
  });

  test("--targets filters and unknown names throw with the known list", () => {
    expect(resolveTargets(config, ["site"]).map((t) => t.def.name)).toEqual(["site"]);
    try {
      resolveTargets(config, ["nope"]);
      throw new Error("expected resolveTargets to throw");
    } catch (e) {
      expect((e as Error).message).toMatch(/unknown target "nope"/);
      expect((e as { hint?: string }).hint).toMatch(/docs, site/);
    }
  });

  test("--routes filter matches by path or name and rejects empty matches", () => {
    const [t] = resolveTargets(config, ["docs"], ["Badge"]);
    expect(t!.routes.map((r) => r.path)).toEqual(["/components/badge"]);
    expect(() => resolveTargets(config, ["site"], ["/nope"])).toThrow(/matched nothing/);
  });
});

describe("util", () => {
  test("parseFlags handles =, spaced values, and booleans", () => {
    const p = parseFlags(["--a=1", "--b", "2", "--c", "--d=x,y"]);
    expect(p.flags).toEqual({ a: "1", b: "2", c: true, d: "x,y" });
  });

  test("isLocalUrl accepts localhost forms and rejects everything else", () => {
    expect(isLocalUrl("http://localhost:8081/x")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:2000")).toBe(true);
    expect(isLocalUrl("http://dashboard.localhost:3001")).toBe(true);
    expect(isLocalUrl("https://example.com")).toBe(false);
  });
});
