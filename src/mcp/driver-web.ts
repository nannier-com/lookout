/**
 * The web driver: one chromium, one page, opened the way a capture opens it
 * (the same viewport, scale factor and reduced motion), so what the
 * navigator sees is what the record will show.
 *
 * Lazy: the browser starts on the first `open`, so a session that only lists
 * tools costs nothing. The page persists across tool calls and is what
 * `arrive` photographs, re-navigating and replaying the actions at every
 * form factor and scheme.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { DEFAULT_VIEWPORTS, DEVICE_SCALE_FACTOR, FORM_FACTORS, type FormFactor } from "../types.js";
import { attachConsoleCollector, type ConsoleCollector } from "../capture/checks.js";
import { schemeUrl, setScheme, settle } from "../capture/web-page.js";
import { harvestRoute } from "../navigate/harvest.js";
import { inventoryBrief } from "../navigate/plan.js";
import type { RouteHarvest } from "../navigate/store.js";
import { resolveRoutes } from "../targets.js";
import { nowIso } from "../util.js";
import type { NavAction } from "./actions.js";
import { arriveWeb } from "./arrive.js";
import type { Arrived, Driver, DriverContext, Snapshot } from "./driver.js";
import { arrivalOf, performWeb, replayWeb, type ReplayContext } from "./replay-web.js";

/** The longest side of a `look` picture: enough to read a screen, cheap enough to send often. */
const LOOK_MAX_PX = 1024;

export class WebDriver implements Driver {
  readonly platform = "web" as const;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private collector: ConsoleCollector | null = null;
  private harvest: RouteHarvest | null = null;
  private signedIn = false;

  constructor(private readonly ctx: DriverContext) {}

  /** The URL a route path opens at: the target's query, and the scheme when the app reads it off the URL. */
  urlFor(path: string): string {
    const route = resolveRoutes({ ...this.ctx.target, routes: [path] }, this.ctx.resolved.config.element, this.ctx.resolved.configPath)[0]!;
    return schemeUrl(this.ctx.resolved, route.url, this.scheme());
  }

  private scheme() {
    return this.ctx.session.matrix.schemes[0] ?? "dark";
  }

  get replayContext(): ReplayContext {
    const s = this.ctx.session;
    return { targetUrl: this.ctx.target.url, urlFor: (p) => this.urlFor(p), exclude: s.exclude, allowDestructive: s.allowDestructive };
  }

  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;
    const { config } = this.ctx.resolved;
    const viewports: Record<FormFactor, { width: number; height: number }> = { ...DEFAULT_VIEWPORTS, ...(config.viewports ?? {}) };
    const widest = FORM_FACTORS.filter((f) => this.ctx.session.matrix.formFactors.includes(f))[0] ?? "desktop";
    this.browser = await chromium.launch({ headless: this.ctx.session.capture.headless });
    this.context = await this.browser.newContext({
      viewport: viewports[widest],
      reducedMotion: "reduce",
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
    });
    this.page = await this.context.newPage();
    this.collector = attachConsoleCollector(this.page);
    return this.page;
  }

  async open(path: string): Promise<NavAction["outcome"]> {
    const page = await this.ensurePage();
    if (!this.signedIn && this.ctx.target.signIn) {
      await this.ctx.target.signIn(page);
      this.signedIn = true;
    }
    await setScheme(this.ctx.resolved, page, this.scheme());
    const outcome = await performWeb(page, { tool: "open", args: { path }, outcome: {}, at: nowIso() }, this.replayContext);
    await settle(page, this.ctx.session.capture.settleMs);
    // The ancestors' recorded actions: the model starts on the parent screen.
    if (this.ctx.session.prelude.length > 0) await replayWeb(page, this.ctx.session.prelude, this.replayContext);
    this.harvest = null;
    return outcome;
  }

  async snapshot(): Promise<Snapshot> {
    const page = await this.ensurePage();
    const s = this.ctx.session;
    this.harvest = await harvestRoute(page, { exclude: s.exclude, include: s.include });
    const refs: Snapshot["refs"] = new Map(this.harvest.affordances.map((a) => [a.id, { kind: "web" as const, affordance: a }]));
    const title = await page.title().catch(() => "");
    const lines = [`url: ${page.url()}`, `title: ${title}`, ""];
    lines.push(this.harvest.affordances.length > 0 ? inventoryBrief(this.harvest) : "(no interactive controls found on this screen)");
    return { text: lines.join("\n"), refs, arrival: arrivalOf(this.harvest, page.url()) };
  }

  async replay(actions: readonly NavAction[]): Promise<void> {
    const page = await this.ensurePage();
    await replayWeb(page, actions.filter((a) => a.tool !== "open"), this.replayContext);
    this.harvest = null;
  }

  async look(): Promise<Buffer> {
    const page = await this.ensurePage();
    const png = await page.screenshot({ animations: "disabled" });
    const sharp = (await import("sharp")).default;
    return sharp(png).resize({ width: LOOK_MAX_PX, height: LOOK_MAX_PX, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 60 }).toBuffer();
  }

  async act(action: NavAction): Promise<NavAction["outcome"]> {
    const page = await this.ensurePage();
    const outcome = await performWeb(page, action, this.replayContext);
    this.harvest = null;
    return outcome;
  }

  async arrive(actions: NavAction[]): Promise<Arrived> {
    const page = await this.ensurePage();
    const s = this.ctx.session;
    const harvest = await harvestRoute(page, { exclude: s.exclude, include: s.include }).catch(() => null);
    const arrival = arrivalOf(harvest, page.url());
    const { shots, failures } = await arriveWeb({
      page,
      resolved: this.ctx.resolved,
      session: s,
      def: this.ctx.target,
      actions,
      replay: this.replayContext,
      log: this.ctx.log,
      collectorDrain: () => this.collector?.drain() ?? [],
    });
    return { shots, failures, arrival };
  }

  async close(): Promise<void> {
    this.collector?.dispose();
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}
