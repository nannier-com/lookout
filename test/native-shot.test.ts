// One photograph of a device: the deep link it cold-starts on, the command
// that switches the device's appearance when the app has no parameter for
// the scheme, and the luminance read-back. Pure, so it runs on a machine with
// neither Xcode nor an Android SDK.
import { describe, expect, test } from "bun:test";
import { appearanceCommand, deepLink, schemeFromLuminance } from "../src/capture/native-shot.js";
import type { NativeDevice } from "../src/capture/native-device.js";

const app = { deepLinkScheme: "acme", bundleId: "com.acme.app" };
const iphone: NativeDevice = { platform: "ios", id: "UDID-1", name: "iPhone 17", formFactor: "phone" };
const pixel: NativeDevice = { platform: "android", id: "emulator-5554", name: "Pixel 9", formFactor: "phone" };

describe("deepLink", () => {
  test("the route rides on the app's scheme, with the leading slash dropped", () => {
    expect(deepLink(app, "/settings", "dark")).toBe("acme:///settings");
    expect(deepLink(app, "/", "dark")).toBe("acme:///");
  });

  test("an app that reads the scheme off the link gets it in the query; one that does not gets nothing", () => {
    expect(deepLink({ ...app, appearanceParam: "scheme" }, "/settings", "light")).toBe(
      "acme:///settings?scheme=light",
    );
    expect(deepLink(app, "/settings", "light")).not.toContain("light");
  });
});

describe("appearanceCommand", () => {
  test("a simulator is switched through simctl ui", () => {
    expect(appearanceCommand(iphone, "dark")).toEqual({
      bin: "xcrun",
      args: ["simctl", "ui", "UDID-1", "appearance", "dark"],
    });
  });

  test("an emulator is switched through the ui mode service, addressed by serial", () => {
    const dark = appearanceCommand(pixel, "dark");
    expect(dark.args).toEqual(["-s", "emulator-5554", "shell", "cmd", "uimode", "night", "yes"]);
    expect(appearanceCommand(pixel, "light").args.at(-1)).toBe("no");
  });
});

describe("schemeFromLuminance", () => {
  test("dark below 60, light above 180, inconclusive between", () => {
    expect(schemeFromLuminance(20)).toBe("dark");
    expect(schemeFromLuminance(220)).toBe("light");
    expect(schemeFromLuminance(120)).toBeNull();
  });
});
