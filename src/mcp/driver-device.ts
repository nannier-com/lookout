/**
 * The device driver: a booted simulator or emulator, addressed the way the
 * native capture addresses it, driven through the platform's own input
 * commands. The navigator drives one device (the phone when one is booted);
 * `arrive` photographs it as it stands, and reaches the same screen on the
 * other booted device of the platform by replaying the recording there.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import { bootedDevices, oneOfEachKind, type NativeDevice, type NativePlatform } from "../capture/native-device.js";
import { deepLink, openOnDevice, shootDevice } from "../capture/native-shot.js";
import { deviceHint, deviceSettleMs } from "../capture/native.js";
import { NavSkip, NavStateError } from "../navigate/execute.js";
import { LookoutError, type NativeAppConfig } from "../types.js";
import { sleep } from "../util.js";
import type { Arrival, NavAction } from "./actions.js";
import {
  describeCommand,
  idbAvailable,
  IDB_HINT,
  keyCommand,
  requireIdb,
  runDevice,
  screenSizeCommand,
  swipeCommand,
  tapCommand,
  textCommand,
} from "./device-commands.js";
import { androidKeyCode, describeFailure, hierarchyText, iosKeyCode, refsOfIdb, refsOfUiautomator, sizeOfWmSize, type Hierarchy } from "./device-hierarchy.js";
import { photographSchemes } from "./device-shot.js";
import { ToolRefusal, type Arrived, type Driver, type DriverContext, type Look, type Snapshot } from "./driver.js";
import { replayDevice, type DeviceActor, type DeviceSize } from "./replay-device.js";

const LOOK_MAX_PX = 1024;
/** A tap space this wide or narrower is photographed at its own size, so the picture reads as coordinates. */
const LOOK_MAX_WIDTH = 1280;
const ACT_SETTLE_MS = 400;
/** What a screen gets to finish moving before it is photographed: a native transition outlasts a web one. */
const ARRIVE_SETTLE_MS = 2000;

export class DeviceDriver implements Driver, DeviceActor {
  readonly platform: NativePlatform;
  private readonly app: NativeAppConfig;
  private booted: NativeDevice[] | null = null;
  private driven: NativeDevice | null = null;
  private last: Hierarchy | null = null;
  /** Why the last `describe` came back empty, for the snapshot to pass on. */
  private describedWhyNot: string | null = null;
  size: DeviceSize | null = null;

  constructor(private readonly ctx: DriverContext) {
    const platform = ctx.session.platform;
    if (platform === "web") throw new LookoutError("the device driver does not drive the web");
    this.platform = platform;
    const app = ctx.resolved.config.native?.[platform];
    if (!app) throw new LookoutError(`this project declares no native.${platform} app`, `add native.${platform} to lookout.config.ts`);
    this.app = app;
  }

  get device(): NativeDevice {
    if (!this.driven) throw new LookoutError(`no ${this.platform} device is booted`, deviceHint(this.platform, this.app));
    return this.driven;
  }

  private async devices(): Promise<NativeDevice[]> {
    if (this.booted) return this.booted;
    this.booted = oneOfEachKind(await bootedDevices(this.platform));
    if (this.booted.length === 0) throw new LookoutError(`no ${this.platform} device is booted`, deviceHint(this.platform, this.app));
    this.driven = this.booted[0]!;
    return this.booted;
  }

  private scheme() {
    return this.ctx.session.matrix.schemes[0] ?? "dark";
  }

  async open(path: string): Promise<NavAction["outcome"]> {
    await this.devices();
    const url = deepLink(this.app, path, this.scheme());
    await openOnDevice(this.device, this.app.bundleId, url);
    await sleep(deviceSettleMs(this.platform, this.app));
    if (this.ctx.session.prelude.length > 0) await replayDevice(this, this.ctx.session.prelude);
    this.last = null;
    return { url };
  }

  /** The screen described by the platform, or null with `describedWhyNot` saying why not. */
  async describe(): Promise<Hierarchy | null> {
    await this.devices();
    if (this.platform === "ios" && !(await idbAvailable())) {
      this.describedWhyNot = IDB_HINT;
      return null;
    }
    const out = await runDevice(describeCommand(this.device)).catch((e: Error) => `ERROR: ${e.message}`);
    const why = describeFailure(out);
    if (why) {
      this.describedWhyNot = why;
      // The tap space still has to be known, or the picture that stands in
      // for the description cannot be read as coordinates either.
      if (!this.size && this.platform === "android") {
        this.size = sizeOfWmSize(await runDevice(screenSizeCommand(this.device)).catch(() => "")) ?? null;
      }
      return null;
    }
    this.describedWhyNot = null;
    const h = this.platform === "ios" ? refsOfIdb(out) : refsOfUiautomator(out);
    if (h.size) this.size = h.size;
    this.last = h;
    return h;
  }

  async snapshot(): Promise<Snapshot> {
    const h = await this.describe();
    const header = `${this.platform} ${this.device.name} (${this.device.formFactor})`;
    if (!h) {
      // No node list: say why, and hand over the picture with the one fact
      // that makes it actionable, which is how its pixels map to a tap.
      const look = await this.look();
      return {
        text: `${header}\n${this.describedWhyNot ?? "this screen could not be described"}.\nUse the picture instead: ${look.note}.`,
        refs: new Map(),
        image: look.image,
        arrival: { sampleNames: [] },
      };
    }
    const refs: Snapshot["refs"] = new Map([...h.refs].map(([id, r]) => [id, { kind: "node" as const, x: r.x, y: r.y, label: r.label, id: r.id, bounds: r.bounds }]));
    return { text: hierarchyText(h, header), refs, arrival: { sampleNames: [...h.refs.values()].slice(0, 12).map((r) => r.label) } };
  }

  async replay(actions: readonly NavAction[]): Promise<void> {
    await this.devices();
    await replayDevice(this, actions);
    this.last = null;
  }

  /**
   * A picture in the coordinates the model taps in, when those fit: an iOS
   * screen is a few hundred points wide, so the picture is simply that size
   * and a position read off it is a tap. When the tap space is larger than
   * a picture should be (Android pixels), the picture is scaled down and the
   * note says by how much, so a position read off it can still be turned
   * into a tap. Measured: a model that was not told tapped below the screen.
   */
  async look(): Promise<Look> {
    await this.devices();
    if (!this.size) await this.describe().catch(() => null);
    const dir = mkdtempSync(join(tmpdir(), "lookout-look-"));
    try {
      const file = join(dir, "look.png");
      await shootDevice(this.device, file);
      const sharp = (await import("sharp")).default;
      const space = this.size;
      // The picture is the tap space itself whenever that is a reasonable
      // width, so a position read off it IS a tap: a phone screen is 400 to
      // 1200 across either way, and only the width has to match.
      const target = space && space.width <= LOOK_MAX_WIDTH ? { width: space.width, height: space.height, fit: "fill" as const } : { width: LOOK_MAX_PX, height: LOOK_MAX_PX, fit: "inside" as const };
      const image = await sharp(await readFile(file)).resize({ ...target, withoutEnlargement: false }).jpeg({ quality: 60 }).toBuffer();
      const meta = await sharp(image).metadata();
      const w = meta.width ?? 0;
      const h = meta.height ?? 0;
      // What to do with it, rather than what it measures: a model reading a
      // picture knows where a thing sits in it as a proportion, and answers
      // in whatever pixel size it believes the picture to be. So it is told
      // to say the proportion and lookout does the arithmetic.
      const note = space
        ? `tap what you see in it with xPct and yPct, as percentages of the screen (the picture is ${w}x${h} and the screen taps in ${space.width}x${space.height}, but you do not need either number)`
        : `this screen's size is not known here, so a position in the picture cannot be turned into a tap; act on nodes from the snapshot`;
      return { image, note };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async perform(action: NavAction, at?: { x: number; y: number }): Promise<void> {
    const device = this.device;
    const a = action.args;
    if (this.platform === "ios" && action.tool !== "wait") await requireIdb(action.tool);
    switch (action.tool) {
      case "tap": {
        const x = at?.x ?? a.x;
        const y = at?.y ?? a.y;
        if (typeof x !== "number" || typeof y !== "number") throw new ToolRefusal("tap names no point");
        await runDevice(tapCommand(device, x, y));
        break;
      }
      case "swipe": {
        if (!a.from || !a.to) throw new ToolRefusal("swipe needs from and to");
        await runDevice(swipeCommand(device, a.from, a.to, a.durationMs ?? 300));
        break;
      }
      case "type": {
        await runDevice(textCommand(device, a.text ?? ""));
        break;
      }
      case "key": {
        const code = this.platform === "ios" ? iosKeyCode(a.key ?? "") : androidKeyCode(a.key ?? "");
        if (code === null) throw new ToolRefusal(`lookout does not know the key ${JSON.stringify(a.key)} on ${this.platform}`);
        await runDevice(keyCommand(device, code));
        break;
      }
      case "back": {
        if (this.platform !== "android") throw new ToolRefusal("iOS has no back button; tap the screen's own back control");
        await runDevice(keyCommand(device, "KEYCODE_BACK"));
        break;
      }
      case "wait": {
        await sleep(Math.min(Math.max(0, a.ms ?? 0), 5000));
        break;
      }
      default:
        throw new ToolRefusal(`${action.tool} is not a device action`);
    }
    await sleep(ACT_SETTLE_MS);
  }

  async act(action: NavAction): Promise<NavAction["outcome"]> {
    await this.devices();
    if (action.tool === "tap" && this.size) {
      action.args.recordedOn = { platform: this.platform, formFactor: this.device.formFactor, width: this.size.width, height: this.size.height };
    }
    await this.perform(action);
    this.last = null;
    return {};
  }

  async arrive(actions: NavAction[]): Promise<Arrived> {
    const devices = await this.devices();
    const s = this.ctx.session;
    // What the screen looks like on arrival, described fresh: the last
    // description was discarded by the action that reached here.
    const described = this.last ?? (await this.describe().catch(() => null));
    const arrival: Arrival = { sampleNames: [...(described?.refs.values() ?? [])].slice(0, 12).map((r) => r.label) };
    const evDir = evidenceDir(this.ctx.resolved);
    const shots: Arrived["shots"] = [];
    const failures: Arrived["failures"] = [];
    const progress = (line: string): void => this.ctx.log.emit(line.startsWith("FAIL") ? "error" : "phase", line);
    const settleMs = deviceSettleMs(this.platform, this.app);
    for (const device of devices) {
      // Reaching the screen again on a device, in a scheme: cold-start on the
      // deep link and replay the whole recording. The other booted device
      // gets the screen this way (a tap that does not transfer is a skip, and
      // the screen is simply not photographed there), and so does the driven
      // device for every scheme past the first when the app reads its scheme
      // off the deep link, the way the web capture replays a state per scheme.
      const actor = device === this.device ? this : Object.assign(new DeviceDriver({ ...this.ctx }), { booted: [device], driven: device });
      const reach = async (scheme: (typeof s.matrix.schemes)[number]): Promise<void> => {
        await openOnDevice(device, this.app.bundleId, deepLink(this.app, s.screen.route, scheme));
        await sleep(settleMs);
        await replayDevice(actor, [...s.prelude, ...actions]);
        // The settle between actions is for the next action, not for a
        // photograph: a tab switch was measured mid-transition, its bar
        // already on the new tab and its body still on the old one. A
        // capture waits longer, once, at the end.
        await sleep(ARRIVE_SETTLE_MS);
      };
      if (device !== this.device) {
        try {
          await reach(this.scheme());
        } catch (e) {
          const why = e instanceof NavSkip || e instanceof NavStateError ? e.message : (e as Error).message.slice(0, 300);
          failures.push({ step: `${this.platform} ${device.formFactor} replay`, message: why });
          progress(`FAIL ${this.platform} ${device.formFactor}: ${why}`);
          continue;
        }
      }
      const r = await photographSchemes({
        device,
        app: this.app,
        axes: { target: s.target, route: s.screen.route, state: s.screen.state, platform: this.platform, formFactor: device.formFactor },
        schemes: s.matrix.schemes,
        evidenceDir: evDir,
        runId: s.runId,
        routeName: s.screen.routeName,
        description: s.screen.description,
        settleMs,
        reopen: reach,
        progress,
      });
      shots.push(...r.shots);
      failures.push(...r.failures);
      for (const shot of r.shots) {
        this.ctx.log.emit("shot", `${shot.target}${shot.route} ${shot.formFactor} ${shot.scheme}`, {
          shotId: shot.id, path: shot.path, route: shot.route, state: shot.state, formFactor: shot.formFactor, scheme: shot.scheme, findings: shot.deterministicFindings.length,
        });
      }
    }
    return { shots, failures, arrival };
  }

  async close(): Promise<void> {
    // A simulator or an emulator outlives every session; there is nothing to close.
  }
}
