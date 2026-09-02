// Which fold a project is judged in, read off a throwaway checkout: the
// repository suggests, the native block enables, and `platforms` decides.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeKind, detectProjectKind } from "../src/project-kind.js";
import type { LookoutConfig } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function checkout(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "lookout-kind-"));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const pkg = (deps: Record<string, string>): string => JSON.stringify({ name: "x", dependencies: deps });
const web: LookoutConfig = { targets: [{ name: "app", url: "http://localhost:3000" }] };
const native: LookoutConfig = {
  ...web,
  native: { ios: { deepLinkScheme: "x", bundleId: "com.x" }, android: { deepLinkScheme: "x", bundleId: "com.x" } },
};

describe("detectProjectKind", () => {
  test("a web application with nothing built for a device is the web fold", async () => {
    const kind = await detectProjectKind(checkout({ "package.json": pkg({ react: "19" }) }), web);
    expect(kind).toMatchObject({ web: true, native: [], suggested: [], declared: false });
    expect(describeKind(kind)).toBe("web (desktop, tablet, phone)");
  });

  test("a React Native application with its native block is the device fold, not the web one", async () => {
    const dir = checkout({ "package.json": pkg({ "react-native": "0.80" }), "ios/Podfile": "", "android/build.gradle": "" });
    const kind = await detectProjectKind(dir, native);
    expect(kind.web).toBe(false);
    expect(kind.native).toEqual(["ios", "android"]);
    expect(kind.suggested).toEqual([]);
    expect(describeKind(kind)).toBe("devices (ios, android)");
    expect(kind.evidence.join("\n")).toContain("react-native in package.json");
  });

  test("a React Native application without a native block keeps the web fold and says what is missing", async () => {
    const dir = checkout({ "package.json": pkg({ expo: "52" }) });
    const kind = await detectProjectKind(dir, web);
    expect(kind.web).toBe(true);
    expect(kind.native).toEqual([]);
    expect(kind.suggested).toEqual(["ios", "android"]);
    expect(kind.evidence.join("\n")).toContain("no native.ios in the config");
  });

  test("React Native for web walks both folds", async () => {
    const dir = checkout({ "package.json": pkg({ "react-native": "0.80", "react-native-web": "0.20" }) });
    const kind = await detectProjectKind(dir, native);
    expect(kind.web).toBe(true);
    expect(kind.native).toEqual(["ios", "android"]);
    expect(describeKind(kind)).toBe("web (desktop, tablet, phone) and devices (ios, android)");
  });

  test("an Xcode project alone suggests ios only, and a configured ios app enables it", async () => {
    const dir = checkout({ "App.xcodeproj/project.pbxproj": "" });
    const suggested = await detectProjectKind(dir, web);
    expect(suggested).toMatchObject({ web: true, native: [], suggested: ["ios"] });
    const enabled = await detectProjectKind(dir, { ...web, native: { ios: { deepLinkScheme: "x", bundleId: "com.x" } } });
    expect(enabled).toMatchObject({ web: false, native: ["ios"], suggested: [] });
  });

  test("platforms in the config is the whole answer", async () => {
    const dir = checkout({ "package.json": pkg({ "react-native": "0.80" }) });
    const kind = await detectProjectKind(dir, { ...web, platforms: ["web"] });
    expect(kind).toMatchObject({ web: true, native: [], suggested: [], declared: true });
    const devices = await detectProjectKind(checkout(), { ...web, platforms: ["ios"] });
    expect(devices).toMatchObject({ web: false, native: ["ios"], declared: true });
  });
});
