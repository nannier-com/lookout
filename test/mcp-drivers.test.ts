// The device half of the tool server, on canned output: what a screen
// description parses to, which commands an action becomes, what an iOS
// action says when idb is not here, and how a recorded tap transfers to
// another device. Nothing here needs a simulator, an emulator, idb or adb.
import { afterEach, describe, expect, test } from "bun:test";
import type { NativeDevice } from "../src/capture/native-device.js";
import {
  androidKeyCode,
  findNode,
  hierarchyText,
  iosKeyCode,
  refsOfIdb,
  refsOfUiautomator,
} from "../src/mcp/device-hierarchy.js";
import { describeCommand, IDB_HINT, keyCommand, requireIdb, swipeCommand, tapCommand, textCommand } from "../src/mcp/device-commands.js";
import { transferTap } from "../src/mcp/replay-device.js";
import { toolsFor, TOOL_NAMES } from "../src/mcp/tools.js";
import type { NavAction } from "../src/mcp/actions.js";

const iphone: NativeDevice = { platform: "ios", id: "UDID-1", name: "iPhone 17", formFactor: "phone" };
const ipad: NativeDevice = { platform: "ios", id: "UDID-2", name: "iPad Air", formFactor: "tablet" };
const pixel: NativeDevice = { platform: "android", id: "emulator-5554", name: "Pixel 9", formFactor: "phone" };

const UIAUTOMATOR = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.acme" content-desc="" clickable="false" bounds="[0,0][1080,2400]">
<node index="0" text="Welcome" resource-id="com.acme:id/title" class="android.widget.TextView" clickable="false" bounds="[40,200][600,280]" />
<node index="1" text="Menu" resource-id="com.acme:id/menu" class="android.widget.Button" clickable="true" bounds="[800,100][1000,180]" />
<node index="2" text="" resource-id="" class="android.widget.ImageView" content-desc="Profile &amp; settings" clickable="true" bounds="[900,2200][1000,2300]" />
<node index="3" text="" resource-id="" class="android.view.View" clickable="false" bounds="[0,0][0,0]" />
<node index="4" text="${"x".repeat(120)}" resource-id="" class="android.widget.TextView" clickable="false" bounds="[0,400][1080,600]" />
</node></hierarchy>`;

const IDB = JSON.stringify([
  { frame: { x: 0, y: 0, width: 393, height: 852 }, type: "Application", AXLabel: "Acme", enabled: true },
  { frame: { x: 300, y: 60, width: 80, height: 44 }, type: "Button", AXLabel: "Menu", AXUniqueId: "menu-button", role_description: "button", enabled: true },
  { frame: { x: 20, y: 120, width: 200, height: 30 }, type: "StaticText", AXLabel: "Welcome", enabled: true },
  { frame: { x: 20, y: 300, width: 353, height: 60 }, type: "Cell", AXLabel: "Pricing", enabled: true },
  { frame: { x: 20, y: 400, width: 80, height: 44 }, type: "Button", AXLabel: "Disabled", enabled: false },
  { frame: { x: 20, y: 500, width: 0, height: 0 }, type: "Button", AXLabel: "Zero", enabled: true },
]);

afterEach(() => {
  delete process.env.LOOKOUT_IDB_BIN;
});

describe("refsOfUiautomator", () => {
  test("clickable and labelled nodes become refs with their centres; empty boxes and walls of text do not", () => {
    const h = refsOfUiautomator(UIAUTOMATOR);
    expect(h.size).toEqual({ width: 1080, height: 2400 });
    expect([...h.refs.entries()].map(([id, r]) => `${id} ${r.role} ${r.label} ${r.x},${r.y}`)).toEqual([
      "n1 text Welcome 320,240",
      "n2 button Menu 900,140",
      "n3 image Profile & settings 950,2250",
    ]);
    expect(h.refs.get("n2")?.id).toBe("com.acme:id/menu");
  });
});

describe("refsOfIdb", () => {
  test("interactive and labelled enabled elements become refs; the application, the disabled and the empty do not", () => {
    const h = refsOfIdb(IDB);
    expect(h.size).toEqual({ width: 393, height: 852 });
    expect([...h.refs.values()].map((r) => `${r.role} ${r.label} ${r.x},${r.y}`)).toEqual(["button Menu 340,82", "statictext Welcome 120,135", "cell Pricing 197,330"]);
    expect([...h.refs.values()][0]?.id).toBe("menu-button");
    expect(refsOfIdb("not json").refs.size).toBe(0);
  });
});

describe("the text and the lookup", () => {
  test("one line per node, the screen size first; findNode by label, then id, then prefix", () => {
    const h = refsOfIdb(IDB);
    const text = hierarchyText(h, "ios iPhone 17 (phone)");
    expect(text).toContain("screen: 393x852 (tap coordinates)");
    expect(text).toContain('- n1 [button] "Menu" id=menu-button at (340, 82)');
    expect(findNode(h, "Menu", "")?.id).toBe("menu-button");
    expect(findNode(h, "gone", "menu-button")?.label).toBe("Menu");
    expect(findNode(h, "Pric", "")?.label).toBe("Pricing");
    expect(findNode(h, "Nope", "nope")).toBeNull();
  });

  test("key names map to what each platform takes, and numbers pass through", () => {
    expect(iosKeyCode("Enter")).toBe(40);
    expect(iosKeyCode("41")).toBe(41);
    expect(iosKeyCode("Meta")).toBeNull();
    expect(androidKeyCode("Enter")).toBe("KEYCODE_ENTER");
    expect(androidKeyCode("Back")).toBe("KEYCODE_BACK");
    expect(androidKeyCode("KEYCODE_CAMERA")).toBe("KEYCODE_CAMERA");
    expect(androidKeyCode("Meta")).toBeNull();
  });
});

describe("the commands", () => {
  test("iOS goes through idb by udid, Android through adb by serial", () => {
    expect(tapCommand(iphone, 340.4, 82)).toEqual({ bin: "idb", args: ["ui", "tap", "340", "82", "--udid", "UDID-1"] });
    expect(tapCommand(pixel, 900, 140).args).toEqual(["-s", "emulator-5554", "shell", "input", "tap", "900", "140"]);
    expect(swipeCommand(iphone, { x: 100, y: 600 }, { x: 100, y: 200 }, 300).args).toEqual(["ui", "swipe", "100", "600", "100", "200", "--duration", "0.3", "--udid", "UDID-1"]);
    expect(swipeCommand(pixel, { x: 100, y: 600 }, { x: 100, y: 200 }, 300).args.slice(-5)).toEqual(["100", "600", "100", "200", "300"]);
    expect(textCommand(iphone, "hello world").args).toEqual(["ui", "text", "hello world", "--udid", "UDID-1"]);
    expect(textCommand(pixel, "hello world").args.slice(-1)).toEqual(["hello%sworld"]);
    expect(keyCommand(iphone, 40).args).toEqual(["ui", "key", "40", "--udid", "UDID-1"]);
    expect(keyCommand(pixel, "KEYCODE_ENTER").args.slice(-2)).toEqual(["keyevent", "KEYCODE_ENTER"]);
    expect(describeCommand(iphone).args).toEqual(["ui", "describe-all", "--json", "--udid", "UDID-1"]);
    expect(describeCommand(pixel).args).toEqual(["-s", "emulator-5554", "exec-out", "uiautomator", "dump", "/dev/tty"]);
  });

  test("an iOS action without idb is refused with the install hint", async () => {
    process.env.LOOKOUT_IDB_BIN = "idb-that-is-not-installed-anywhere";
    await expect(requireIdb("tap")).rejects.toThrow(IDB_HINT);
    await expect(requireIdb("tap")).rejects.toThrow(/tap needs idb/);
  });
});

describe("transferTap", () => {
  const tap = (over: Partial<NavAction["args"]>): NavAction => ({ tool: "tap", args: { x: 340, y: 82, ...over }, outcome: {}, at: "t" });
  const recordedOn = { platform: "ios" as const, formFactor: "phone" as const, width: 393, height: 852 };

  test("a labelled tap is re-resolved in the fresh hierarchy, and refused when the label is gone", () => {
    const h = refsOfIdb(IDB);
    expect(transferTap(tap({ label: "Pricing", recordedOn }), ipad, { width: 820, height: 1180 }, h)).toEqual({ x: 197, y: 330 });
    expect(() => transferTap(tap({ label: "Vanished", recordedOn }), ipad, null, h)).toThrow(/is not on this screen/);
  });

  test("coordinates transfer to the same platform and form factor, scaled by width, and to nothing else", () => {
    expect(transferTap(tap({ recordedOn }), iphone, { width: 786, height: 1704 }, null)).toEqual({ x: 680, y: 164 });
    expect(transferTap(tap({ recordedOn }), iphone, null, null)).toEqual({ x: 340, y: 82 });
    expect(transferTap(tap({}), ipad, null, null)).toEqual({ x: 340, y: 82 });
    expect(() => transferTap(tap({ recordedOn }), ipad, { width: 820, height: 1180 }, null)).toThrow(/does not transfer/);
    expect(() => transferTap(tap({ recordedOn }), pixel, null, null)).toThrow(/does not transfer/);
    expect(() => transferTap(tap({ x: undefined, y: undefined }), iphone, null, null)).toThrow(/names no point/);
  });
});

describe("the registry", () => {
  test("a device session sees the device tools and the shared ones, one per name; the web sees its own", () => {
    expect(toolsFor("ios").map((t) => t.name).sort()).toEqual(["arrive", "key", "look", "open", "swipe", "tap", "type", "wait"]);
    expect(toolsFor("android").map((t) => t.name).sort()).toEqual(["arrive", "back", "key", "look", "open", "swipe", "tap", "type", "wait"]);
    expect(toolsFor("web").map((t) => t.name)).not.toContain("tap");
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
    expect(TOOL_NAMES).toContain("tap");
  });
});
