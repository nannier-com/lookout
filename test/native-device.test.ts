// Which devices a native capture can address, read off canned tool output:
// an iPad is a tablet, a booted watch is nobody's phone, and Android's own
// build characteristics decide its kind.
import { describe, expect, test } from "bun:test";
import { deviceOfAndroid, devicesOfSimctl, oneOfEachKind, serialsOfAdb } from "../src/capture/native-device.js";

const simctl = (devices: Record<string, { state: string; udid: string; name: string; deviceTypeIdentifier: string }[]>) =>
  JSON.stringify({ devices });

const IPHONE = { state: "Booted", udid: "AAAA", name: "iPhone 17", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17" };
const IPAD = { state: "Booted", udid: "BBBB", name: "iPad Pro 11-inch (M4)", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M4" };

describe("devicesOfSimctl", () => {
  test("a booted iPhone is a phone, a booted iPad a tablet, addressed by udid", () => {
    const out = devicesOfSimctl(simctl({ "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [IPHONE, IPAD] }));
    expect(out).toEqual([
      { platform: "ios", id: "AAAA", name: "iPhone 17", formFactor: "phone" },
      { platform: "ios", id: "BBBB", name: "iPad Pro 11-inch (M4)", formFactor: "tablet" },
    ]);
  });

  test("a shutdown iPad beside a booted iPhone is not a device", () => {
    const out = devicesOfSimctl(simctl({ "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [IPHONE, { ...IPAD, state: "Shutdown" }] }));
    expect(out.map((d) => d.formFactor)).toEqual(["phone"]);
  });

  test("a booted watch or tv is not a phone", () => {
    const watch = { state: "Booted", udid: "W", name: "Apple Watch Ultra 3", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Ultra-3-49mm" };
    const out = devicesOfSimctl(simctl({ "com.apple.CoreSimulator.SimRuntime.watchOS-26-2": [watch] }));
    expect(out).toEqual([]);
  });

  test("nothing booted, or output that is not JSON, is no device", () => {
    expect(devicesOfSimctl(simctl({ "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [] }))).toEqual([]);
    expect(devicesOfSimctl("xcrun: error")).toEqual([]);
  });
});

describe("Android", () => {
  test("serials come from the ready lines of adb devices -l", () => {
    const out = "List of devices attached\nemulator-5554          device product:sdk_gphone64 model:Pixel_9 device:emu64a\n0123456789ABCDEF       unauthorized\nemulator-5556 offline\n";
    expect(serialsOfAdb(out)).toEqual(["emulator-5554"]);
  });

  test("the build's characteristics decide the kind; the model is the name", () => {
    expect(deviceOfAndroid("emulator-5554", "Pixel Tablet\n", "nosdcard,tablet\n")).toEqual({
      platform: "android",
      id: "emulator-5554",
      name: "Pixel Tablet",
      formFactor: "tablet",
    });
    expect(deviceOfAndroid("emulator-5556", "Pixel 9", "default").formFactor).toBe("phone");
    expect(deviceOfAndroid("emulator-5556", "", "").name).toBe("emulator-5556");
  });
});

describe("oneOfEachKind", () => {
  test("keeps the first phone and the first tablet, in that order", () => {
    const a = { platform: "ios" as const, id: "1", name: "iPad A", formFactor: "tablet" as const };
    const b = { platform: "ios" as const, id: "2", name: "iPhone B", formFactor: "phone" as const };
    const c = { platform: "ios" as const, id: "3", name: "iPhone C", formFactor: "phone" as const };
    expect(oneOfEachKind([a, b, c]).map((d) => d.id)).toEqual(["2", "1"]);
    expect(oneOfEachKind([])).toEqual([]);
  });
});
