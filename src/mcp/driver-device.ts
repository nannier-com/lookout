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
  swipeCommand,
  tapCommand,
  textCommand,
} from "./device-commands.js";
import { androidKeyCode, hierarchyText, iosKeyCode, refsOfIdb, refsOfUiautomator, type Hierarchy } from "./device-hierarchy.js";
import { photographSchemes } from "./device-shot.js";
import { ToolRefusal, type Arrived, type Driver, type DriverContext, type Snapshot } from "./driver.js";
import { replayDevice, type DeviceActor, type DeviceSize } from "./replay-device.js";

const LOOK_MAX_PX = 1024;
const ACT_SETTLE_MS = 400;

export class DeviceDriver implements Driver, DeviceActor {
  readonly platform: NativePlatform;
  private readonly app: NativeAppConfig;
  private booted: NativeDevice[] | null = null;
  private driven: NativeDevice | null = null;
  private last: Hierarchy | null = null;
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

  /** The screen described by the platform, or null when this platform cannot describe it here. */
  async describe(): Promise<Hierarchy | null> {
    await this.devices();
    if (this.platform === "ios" && !(await idbAvailable())) return null;
    const out = await runDevice(describeCommand(this.device));
    const h = this.platform === "ios" ? refsOfIdb(out) : refsOfUiautomator(out);
    if (h.size) this.size = h.size;
    this.last = h;
    return h;
  }

  async snapshot(): Promise<Snapshot> {
    const h = await this.describe();
    const header = `${this.platform} ${this.device.name} (${this.device.formFactor})`;
    if (!h) {
      return {
        text: `${header}\n(this simulator cannot describe its screen: ${IDB_HINT}; look at the picture instead)`,
        refs: new Map(),
        image: await this.look(),
      };
    }
    const refs: Snapshot["refs"] = new Map([...h.refs].map(([id, r]) => [id, { kind: "node" as const, x: r.x, y: r.y, label: r.label, id: r.id, bounds: r.bounds }]));
    return { text: hierarchyText(h, header), refs };
  }

  async look(): Promise<Buffer> {
    await this.devices();
    const dir = mkdtempSync(join(tmpdir(), "lookout-look-"));
    try {
      const file = join(dir, "look.png");
      await shootDevice(this.device, file);
      const sharp = (await import("sharp")).default;
      return await sharp(await readFile(file)).resize({ width: LOOK_MAX_PX, height: LOOK_MAX_PX, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer();
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
    const evDir = evidenceDir(this.ctx.resolved);
    const shots: Arrived["shots"] = [];
    const failures: Arrived["failures"] = [];
    const progress = (line: string): void => this.ctx.log.emit(line.startsWith("FAIL") ? "error" : "phase", line);
    const settleMs = deviceSettleMs(this.platform, this.app);
    for (const device of devices) {
      if (device !== this.device) {
        // The other booted device of this platform gets the same screen by
        // replaying the recording there; a tap that does not transfer is a
        // skip, and the screen is simply not photographed on that device.
        try {
          await openOnDevice(device, this.app.bundleId, deepLink(this.app, s.screen.route, this.scheme()));
          await sleep(settleMs);
          const actor = new DeviceDriver({ ...this.ctx });
          actor.booted = [device];
          actor.driven = device;
          await replayDevice(actor, [...s.prelude, ...actions]);
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
    const arrival: Arrival = { sampleNames: [...(this.last?.refs.values() ?? [])].slice(0, 12).map((r) => r.label) };
    return { shots, failures, arrival };
  }

  async close(): Promise<void> {
    // A simulator or an emulator outlives every session; there is nothing to close.
  }
}
