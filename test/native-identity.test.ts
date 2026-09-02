// A device finding is its own defect. The fingerprint and the issue key carry
// the platform for ios and android, and stay byte-identical for the web, so
// every backlog that exists keeps every id it has.
import { describe, expect, test } from "bun:test";
import { fingerprintOf } from "../src/backlog/fingerprint.js";
import { clusterKeyOf } from "../src/fix/cluster.js";

const axes = { target: "app", route: "/settings", state: "rest", formFactor: "phone" as const, scheme: "dark" as const, category: "layout-overflow" as const, attribute: "horizontal-scroll" };

describe("fingerprintOf", () => {
  test("a web finding's fingerprint is what it always was", () => {
    expect(fingerprintOf(axes)).toBe("app.settings.rest.phone.dark.layout-overflow.horizontal-scroll");
    expect(fingerprintOf({ ...axes, platform: "web" })).toBe("app.settings.rest.phone.dark.layout-overflow.horizontal-scroll");
  });

  test("a device finding carries its platform, so an iOS phone and a web phone never merge", () => {
    expect(fingerprintOf({ ...axes, platform: "ios" })).toBe("app.settings.rest.ios.phone.dark.layout-overflow.horizontal-scroll");
    expect(fingerprintOf({ ...axes, platform: "android", formFactor: "tablet" })).toBe(
      "app.settings.rest.android.tablet.dark.layout-overflow.horizontal-scroll",
    );
  });
});

describe("clusterKeyOf", () => {
  const finding = { target: "app", route: "/settings", category: "layout-overflow" as const, attribute: "horizontal-scroll", channel: "ai" as const };

  test("a web issue keys as before; a device issue is its own piece of work", () => {
    expect(clusterKeyOf(finding)).toBe("app--layout-overflow--horizontal-scroll");
    expect(clusterKeyOf({ ...finding, platform: "web" })).toBe("app--layout-overflow--horizontal-scroll");
    expect(clusterKeyOf({ ...finding, platform: "ios" })).toBe("app--ios--layout-overflow--horizontal-scroll");
  });

  test("a deterministic accessibility locus keeps the platform too", () => {
    const a11y = { ...finding, category: "a11y" as const, channel: "deterministic" as const };
    expect(clusterKeyOf(a11y)).toBe("app--settings--a11y");
    expect(clusterKeyOf({ ...a11y, platform: "android" })).toBe("app--android--settings--a11y");
  });
});
