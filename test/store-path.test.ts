// Where a shot's file lives. The form factor is in every platform's filename:
// a phone and a tablet shot of one route on one platform used to share a path.
import { describe, expect, test } from "bun:test";
import { shotId, shotRelPath } from "../src/capture/store.js";

describe("shotRelPath", () => {
  test("web paths are unchanged", () => {
    expect(shotRelPath({ target: "app", route: "/settings", state: "rest", platform: "web", formFactor: "desktop", scheme: "dark" })).toBe(
      "web/app/settings/rest--desktop-dark.png",
    );
  });

  test("a native phone and a native tablet shot of one route are two files", () => {
    const phone = shotRelPath({ target: "app", route: "/", state: "rest", platform: "ios", formFactor: "phone", scheme: "dark" });
    const tablet = shotRelPath({ target: "app", route: "/", state: "rest", platform: "ios", formFactor: "tablet", scheme: "dark" });
    expect(phone).toBe("ios/app/root/rest--phone-dark.png");
    expect(tablet).toBe("ios/app/root/rest--tablet-dark.png");
    expect(shotId({ target: "app", route: "/", state: "rest", platform: "ios", formFactor: "tablet", scheme: "dark" })).toBe(
      "ios/app/root/rest/tablet/dark",
    );
  });
});
