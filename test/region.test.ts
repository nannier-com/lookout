// The region axis: which part of the frame a defect lives in, and the one
// place it may change a fingerprint. The stability test in backlog.test.ts is
// the contract this must not disturb; these are the new behaviours around it.
import { describe, expect, test } from "bun:test";
import { fingerprintOf } from "../src/backlog/fingerprint.js";
import { REGIONS, isShellRegion, parseRegion, regionFromSelectors } from "../src/backlog/region.js";
import { clusterKeyOf } from "../src/fix/cluster.js";
import { routeSlug } from "../src/capture/store.js";

const axes = {
  target: "app",
  route: "/checkout",
  state: "rest",
  formFactor: "phone" as const,
  scheme: "dark" as const,
  category: "layout-overflow",
  attribute: "horizontal-scroll",
};

describe("the region axis", () => {
  test("a shell region takes the route's slot in the fingerprint", () => {
    expect(fingerprintOf({ ...axes, region: "shell-nav" })).toBe(
      "app.@shell-nav.rest.phone.dark.layout-overflow.horizontal-scroll",
    );
  });

  test("the same shell defect fingerprints identically from any route", () => {
    const fromCheckout = fingerprintOf({ ...axes, region: "shell-header" });
    const fromSettings = fingerprintOf({ ...axes, route: "/settings", region: "shell-header" });
    expect(fromCheckout).toBe(fromSettings);
  });

  test("content and absent derive the identical route-keyed fingerprint", () => {
    const absent = fingerprintOf(axes);
    expect(fingerprintOf({ ...axes, region: "content" })).toBe(absent);
    expect(absent).toBe("app.checkout.rest.phone.dark.layout-overflow.horizontal-scroll");
  });

  test("form factor and scheme survive in a shell fingerprint", () => {
    // A desktop rail and a phone tab bar are different components; the region
    // replaces only the route.
    const phone = fingerprintOf({ ...axes, region: "shell-nav" });
    const desktop = fingerprintOf({ ...axes, formFactor: "desktop", region: "shell-nav" });
    expect(phone).not.toBe(desktop);
  });

  test("routeSlug can never spell a region: @ is unreachable", () => {
    const hostile = [
      "/@shell-nav",
      "/shell-nav",
      "/@/shell/nav",
      "/a@b",
      "/%40shell-nav",
      "/ @shell-nav ",
      "/@@",
      "/@" + "shell-header",
    ];
    for (const route of hostile) {
      expect(routeSlug(route)).not.toContain("@");
      // A route literally named like a region stays route-keyed and distinct
      // from the shell identity of the same axes.
      expect(fingerprintOf({ ...axes, route })).not.toBe(
        fingerprintOf({ ...axes, region: "shell-nav" }),
      );
    }
  });

  test("parseRegion holds the closed set and rejects everything else", () => {
    for (const r of REGIONS) expect(parseRegion(r)).toBe(r);
    for (const bad of ["nav", "shell", "header", "SHELL-NAV", "", 3, null, undefined]) {
      expect(parseRegion(bad)).toBeUndefined();
    }
  });

  test("regionFromSelectors: landmark ancestry only, whole violations only, agreement only", () => {
    // Fires: every node inside the same landmark element or role.
    expect(regionFromSelectors(["nav > ul > li > a"], 1)).toBe("shell-nav");
    expect(regionFromSelectors(["header > .actions > button", "header > .brand"], 2)).toBe("shell-header");
    expect(regionFromSelectors(['[role="contentinfo"] > p'], 1)).toBe("shell-footer");
    expect(regionFromSelectors(["#app > nav:nth-child(2) > a"], 1)).toBe("shell-nav");
    // Class names are project vocabulary, never consulted.
    expect(regionFromSelectors([".navbar > a"], 1)).toBeUndefined();
    expect(regionFromSelectors([".page-header > h1"], 1)).toBeUndefined();
    // A sample of a larger violation proves nothing.
    expect(regionFromSelectors(["nav > a", "nav > a", "nav > a"], 5)).toBeUndefined();
    // Disagreement or ambiguity declines.
    expect(regionFromSelectors(["nav > a", "footer > a"], 2)).toBeUndefined();
    expect(regionFromSelectors(["header > nav > a"], 1)).toBeUndefined();
    expect(regionFromSelectors([], 0)).toBeUndefined();
  });

  test("a chrome a11y cluster keys by region; a content one keeps its route", () => {
    const base = {
      target: "app",
      route: "/identities",
      category: "a11y",
      attribute: "axe-button-name",
      channel: "deterministic",
    } as const;
    expect(clusterKeyOf({ ...base })).toBe("app--identities--a11y");
    expect(clusterKeyOf({ ...base, region: "content" })).toBe("app--identities--a11y");
    expect(clusterKeyOf({ ...base, region: "shell-nav" })).toBe("app--shell-nav--a11y");
    expect(clusterKeyOf({ ...base, route: "/settings", region: "shell-nav" })).toBe("app--shell-nav--a11y");
  });

  test("only shell regions count as shell", () => {
    expect(isShellRegion("shell-nav")).toBe(true);
    expect(isShellRegion("shell-header")).toBe(true);
    expect(isShellRegion("shell-footer")).toBe(true);
    expect(isShellRegion("content")).toBe(false);
    expect(isShellRegion(undefined)).toBe(false);
  });
});
