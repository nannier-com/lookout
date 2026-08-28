// Pointing a configured project at a different origin.
//
// The distinction this file guards: --url REPLACES the config with a single
// synthetic target, so the routes, viewports, state recipes and signIn hook a
// project wrote all disappear. --base-url MOVES the config's targets and keeps
// every one of them. Confusing the two silently turns a 126-route run into a
// one-route run, which looks like a pass.
import { describe, expect, test } from "bun:test";
import { applyBaseUrl } from "../src/config.js";
import { validBaseUrl } from "../src/verbs/ui-settings.js";
import { LookoutError, type LookoutConfig } from "../src/types.js";

function config(): LookoutConfig {
  return {
    targets: [
      { name: "docs", url: "http://localhost:8081", routes: ["/a", "/b", "/c"] },
      { name: "glass", url: "http://localhost:8081", routes: ["/d"] },
    ],
  };
}

describe("applyBaseUrl", () => {
  test("moves every target and keeps what the config said about them", () => {
    const c = config();
    applyBaseUrl(c, "http://localhost:3000");
    expect(c.targets.map((t) => t.url)).toEqual([
      "http://localhost:3000",
      "http://localhost:3000",
    ]);
    // The point of the whole feature: a different port does not make a
    // project's routes wrong, so they must survive.
    expect(c.targets[0]!.routes).toHaveLength(3);
    expect(c.targets[1]!.routes).toHaveLength(1);
    expect(c.targets.map((t) => t.name)).toEqual(["docs", "glass"]);
  });

  test("a target mounted under a path keeps that path", () => {
    // The port says which machine; the path says where the app is mounted on
    // it. Only the first is what an override is about.
    const c: LookoutConfig = { targets: [{ name: "app", url: "http://localhost:8081/admin" }] };
    applyBaseUrl(c, "http://localhost:3000");
    expect(c.targets[0]!.url).toBe("http://localhost:3000/admin");
  });

  test("a port change alone is enough", () => {
    const c = config();
    applyBaseUrl(c, "http://127.0.0.1:4321");
    expect(c.targets[0]!.url).toBe("http://127.0.0.1:4321");
  });

  test("nonsense is refused with the flag named, not silently ignored", () => {
    expect(() => applyBaseUrl(config(), "not a url")).toThrow(LookoutError);
  });
});

describe("validBaseUrl", () => {
  test("accepts an origin and normalises to it", () => {
    expect(validBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(validBaseUrl("  http://localhost:3000/ignored  ")).toBe("http://localhost:3000");
  });

  test("rejects what cannot be an origin", () => {
    for (const bad of ["", "   ", "not a url", "localhost:3000", "://x"]) {
      expect(validBaseUrl(bad)).toBeNull();
    }
  });
});
