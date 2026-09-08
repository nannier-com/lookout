#!/usr/bin/env bun
/**
 * The gate for anything `lookout ui` renders.
 *
 * Type checks and tests say nothing about what a browser draws. Three real bugs
 * in this repo passed every other gate and were caught here: a filter bar with
 * no `[hidden]` rule that could not be hidden, and two optional fields
 * dereferenced after being guarded on a copy.
 *
 * The manual commands bracket a change: `fixture` builds a throwaway
 * project with something in every part of the page, `serve` points the ui at
 * it, `shots` captures a fixed set of views, `diff` compares two captures pixel
 * by pixel, and `drive` clicks through the page and asserts what should happen.
 *
 * `ci` owns that whole lifecycle for automation. See README.md beside this
 * file for the manual order.
 */
import { chromium, type Page } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildFixture } from "./fixture.js";
import { changeSaid, diffPng, writeDiffCrop } from "../../src/verify/pixels.js";

const ROOT = join(import.meta.dir, "..", "..");
const WORK = join(ROOT, ".lookout-ui-check");
let port = Number(process.env.UI_CHECK_PORT ?? 7399);
let url = `http://127.0.0.1:${port}/`;

function fixturePaths(): { project: string; checkout: string; claudeBin: string } {
  return {
    project: join(WORK, "fixture", "project"),
    checkout: join(WORK, "fixture", "checkout"),
    claudeBin: join(WORK, "fixture", "bin", "claude"),
  };
}

/** Capture one view, after letting the page settle. */
async function view(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  out: string,
  name: string,
  scheme: "dark" | "light",
  width: number,
  height: number,
  act: (p: Page) => Promise<void>,
  problems: string[],
): Promise<void> {
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width, height } });
  try {
    const page = await ctx.newPage();
    page.on("pageerror", (e) => problems.push(`${name}: ${String(e)}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`${name}: console ${m.text()}`);
    });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    await act(page);
    // Settle: a filter tile smooth-scrolls and flashes for over a second, and a
    // focus ring on whatever was clicked differs between runs rather than between
    // revisions. Both are noise this gate must not report.
    await page.waitForTimeout(1600);
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(400);
    // A card mid-verify pulses its pill and blinks a cursor on its feed. Those
    // are infinite animations, and two captures of one would differ by whatever
    // frame each happened to land on. Playwright parks them at a fixed state.
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: true, animations: "disabled" });
  } finally {
    await ctx.close();
  }
}

async function shots(label: string): Promise<number> {
  const out = join(WORK, "shots", label);
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const problems: string[] = [];
  try {
    const nothing = async (): Promise<void> => {};
    await view(browser, out, "board-dark", "dark", 1440, 950, nothing, problems);
    await view(browser, out, "board-light", "light", 1440, 950, nothing, problems);
    await view(browser, out, "board-narrow", "light", 430, 900, nothing, problems);
    await view(browser, out, "board-filtered", "dark", 1440, 950, (p) => p.click('[data-testid="stat-archived"]'), problems);
    // The settled issue, which is the only card carrying both halves of a pre and
    // post fix pair. It is filtered off the default board, so without this view
    // the comparison the page exists to show is never captured.
    await view(browser, out, "board-done", "dark", 1440, 950, (p) => p.click('[data-testid="stat-done"]'), problems);
    await view(browser, out, "settings-open", "dark", 1440, 950, (p) => p.click('[data-testid="settings-button"]'), problems);
    // The same panel where it has the least room. It floats beside the rail
    // rather than filling a header row, so how wide it is and whether it still
    // fits above its own button are questions only a narrow capture answers.
    await view(browser, out, "settings-narrow", "light", 430, 900, (p) => p.click('[data-testid="settings-button"]'), problems);
    // The judge's column folded away. A state the page can be left in, so it is a
    // state the gate has to have a picture of: the strip at the edge and the
    // board's new width are both things only a capture shows.
    await view(browser, out, "judge-shut", "dark", 1440, 950, (p) => p.click('[data-testid="judge-fold"]'), problems);
    await view(browser, out, "learning-dark", "dark", 1440, 950, (p) => p.click('[data-testid="area-learning"]'), problems);
    await view(browser, out, "learning-light", "light", 1440, 950, (p) => p.click('[data-testid="area-learning"]'), problems);
    await view(browser, out, "learning-narrow", "dark", 430, 900, (p) => p.click('[data-testid="area-learning"]'), problems);
    // The shot inspector over the one fixture shot that carries a sidecar: the
    // archived card's live tile (cards with frozen frames show the frames,
    // which are copies and never advertise). Deterministic because the hint is
    // painted on open and a box is clicked rather than hovered.
    const openTile = async (p: Page): Promise<void> => {
      await p.click('[data-testid="stat-archived"]');
      await p.click('[data-testid="shot-prov"]');
      const box = p.locator('[data-testid="shot-box"][aria-label*="Heading.tsx"]');
      await box.waitFor({ state: "visible" });
      await p.waitForTimeout(1_000);
      await box.click();
    };
    await view(browser, out, "shot-overlay-dark", "dark", 1440, 950, openTile, problems);
    await view(browser, out, "shot-overlay-light", "light", 1440, 950, openTile, problems);
    await view(browser, out, "shot-overlay-narrow", "dark", 430, 900, openTile, problems);
  } finally {
    await browser.close();
  }
  console.log(`${label}: ${readdirSync(out).filter((n) => n.endsWith(".png")).length} views in ${out}`);
  console.log(problems.length ? `PROBLEMS:\n${problems.join("\n")}` : "no page or console errors");
  return problems.length;
}

/** Wait until the real UI server answers before opening Chromium. */
async function waitForServer(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (terminated(child)) throw new Error(`lookout ui terminated ${child.exitCode ?? child.signalCode} before it became ready`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The socket is not listening yet. Try again until the bounded deadline.
    }
    await Bun.sleep(100);
  }
  throw new Error(`lookout ui did not answer ${url} within 15 seconds`);
}

function terminated(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (terminated(child)) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = (): void => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once("exit", onExit);
    if (terminated(child)) done(true);
  });
}

async function waitUntilExit(child: ChildProcess): Promise<void> {
  if (terminated(child)) return;
  await new Promise<void>((resolve) => {
    const onExit = (): void => {
      child.off("exit", onExit);
      resolve();
    };
    child.once("exit", onExit);
    if (terminated(child)) onExit();
  });
}

/** Start the same source or installed CLI that a person runs. */
function startServer(): ChildProcess {
  const { project, checkout, claudeBin } = fixturePaths();
  const cli = process.env.UI_CHECK_CLI ?? join(ROOT, "src", "cli.ts");
  return spawn(process.execPath, [cli, "ui", "--port", String(port)], {
    cwd: project,
    env: {
      ...process.env,
      LOOKOUT_CHECKOUT: checkout,
      LOOKOUT_NO_HANDOFF: "1",
      LOOKOUT_CLAUDE_BIN: claudeBin,
    },
    stdio: "inherit",
  });
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a loopback port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (terminated(child)) return;
  child.kill("SIGINT");
  if (await waitForExit(child, 5_000)) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 5_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(child, 5_000))) throw new Error("lookout ui did not exit after SIGKILL");
}

/** The noninteractive CI gate: fixture, real server, screenshots, and behavior. */
async function ci(): Promise<number> {
  if (process.env.UI_CHECK_PORT == null) {
    port = await freePort();
    url = `http://127.0.0.1:${port}/`;
  }
  await buildFixture(join(WORK, "fixture"));
  const child = startServer();
  try {
    await waitForServer(child);
    return (await shots("ci")) + (await drive());
  } finally {
    await stopServer(child);
  }
}

/**
 * Compare two captures, and crop what differs.
 *
 * A refactor should come out identical, or differing only in the relative
 * "seen" clock the fixture carries. The crop beside a differing view is how you
 * tell those apart without guessing.
 */
async function diff(a: string, b: string): Promise<number> {
  const dirA = join(WORK, "shots", a);
  const dirB = join(WORK, "shots", b);
  let worst = 0;
  for (const f of readdirSync(dirA).filter((n) => n.endsWith(".png"))) {
    const fileB = join(dirB, f);
    if (!existsSync(fileB)) {
      console.log(`${f.padEnd(22)} MISSING in ${b}`);
      worst = 100;
      continue;
    }
    const d = await diffPng(join(dirA, f), fileB);
    if (!d) {
      console.log(`${f.padEnd(22)} UNREADABLE`);
      worst = 100;
      continue;
    }
    if (d.changed === 0) {
      console.log(`${f.padEnd(22)} identical`);
      continue;
    }
    // A size change is a maximal alarm for this gate whatever its percentage:
    // the fixture's clock is frozen, so nothing should be resizing at all.
    const pct = d.fraction * 100;
    worst = Math.max(worst, d.sizeChanged ? 100 : pct);
    const crop = d.box
      ? await writeDiffCrop(fileB, d.box, join(WORK, "shots", `${b}-crop-${f}`))
      : null;
    console.log(`${f.padEnd(22)} ${d.changed} px differ (${pct.toFixed(3)}%)  ${changeSaid(d)}${crop ? `  ${crop}` : ""}`);
  }
  console.log(worst === 0 ? "\nALL IDENTICAL" : `\nworst: ${worst.toFixed(3)}%`);
  return worst;
}

/** Click through the page and assert what each control is supposed to do. */
async function drivePage(page: Page): Promise<number> {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${String(e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);

  let failed = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) failed++;
    console.log(`${ok ? "pass  " : "FAIL  "}${name}${detail ? `  ${detail}` : ""}`);
  };
  const checkAccessibility = async (name: string): Promise<void> => {
    const result = await new AxeBuilder({ page }).analyze();
    check(
      `${name} has no automated accessibility violations`,
      result.violations.length === 0,
      result.violations.map((violation) => `${violation.id}: ${violation.nodes.length}`).join(", "),
    );
  };
  const shown = (): Promise<string[]> => page.locator('[data-testid="issue-card"] [data-testid="issue-id"]').allTextContents();

  const before = await shown();
  check("board renders cards", before.length > 0, `ids=${before.join(",")}`);
  await checkAccessibility("board");

  // The document link, on every card, followed rather than counted. A card
  // linking a 404 is indistinguishable from one linking a document until
  // somebody clicks it, and the URL is spelled in the client and matched in the
  // server, so the only check worth making is whether the file comes back.
  const docs = page.locator('[data-testid="issue-card"] [data-testid="issue-doc"]');
  const links = await docs.count();
  check("every card links its document", links === before.length, `${links} links for ${before.length} cards`);
  const href = links > 0 ? await docs.first().getAttribute("href") : null;
  const doc = href ? await page.request.get(url + href.replace(/^\//, "")) : null;
  check("the document link resolves", doc?.status() === 200, `${href} -> ${doc?.status() ?? "not requested"}`);
  const text = doc ? await doc.text() : "";
  check("what comes back is that issue's document", text.includes(`issue:      ${before[0]}`), text.slice(0, 40));

  // The fixture has one issue in each of open, adjudicated and settled, and the
  // board shows one status at a time, so what a filter changes is which card is
  // on the board, not how many.
  await page.click('[data-testid="stat-archived"]');
  await page.waitForTimeout(1200);
  const during = await shown();
  check("filter changes which issues show", during.join() !== before.join(), `${before.join(",")} -> ${during.join(",")}`);
  check("filter bar appears", await page.locator("#filterbar").isVisible());
  // The intentional issue's folder was never written, so its card has nothing
  // to link. Offering a link there would be offering a 404.
  check("a card with no document on disk links none", (await docs.count()) === 0, `${await docs.count()} links`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1200);
  check("escape restores the board", (await shown()).join() === before.join());
  check("filter bar goes away", !(await page.locator("#filterbar").isVisible()));

  // The tool picker is a selector, not a switch: pressing the second one adds
  // it to the first rather than replacing it, because two selected means they
  // take turns on one issue. The last one on cannot be turned off, since a
  // selection of nothing leaves the play button with nobody to hand an issue to.
  const buttons = page.locator('#toolToggle [data-testid="tool-choice"]');
  if ((await buttons.count()) > 1) {
    const first = buttons.nth(0);
    const second = buttons.nth(1);
    const key = await second.getAttribute("data-tool");
    await second.locator("button").click();
    await page.waitForTimeout(1200);
    check("a second tool can be selected", (await second.getAttribute("data-selected")) === "true", String(key));
    check("selecting one does not deselect the other", (await first.getAttribute("data-selected")) === "true");
    const stored = await page.evaluate(() => localStorage.getItem("lookout.tools"));
    check("both are remembered", (stored ?? "").includes(String(key)), String(stored));
    await second.locator("button").click();
    await page.waitForTimeout(900);
    check("and one can be taken back off", (await second.getAttribute("data-selected")) === "false");
    await first.locator("button").click();
    await page.waitForTimeout(900);
    check("but never the last one", (await first.getAttribute("data-selected")) === "true");

    // A selection nobody can see is a control that does not work, and the
    // attributes above are true of one. Two things have to hold in the pixels:
    // the tool's mark actually loads, and the selected one is the one wearing
    // a surface. The marks reach the page as data: URIs, so a mark a browser
    // refuses paints nothing and reports nothing; react-native-web leaves the
    // box behind with `background-image: none`, which is what this reads.
    const marks = page.locator("#toolToggle button > div:first-child > div");
    const painted = await marks.evaluateAll((nodes) =>
      nodes.map((n) => getComputedStyle(n).backgroundImage !== "none"));
    check("every tool's mark paints", painted.length > 0 && painted.every(Boolean), painted.join(","));

    const surface = async (): Promise<string[]> =>
      page.locator("#toolToggle button").evaluateAll((nodes) =>
        nodes.map((n) => getComputedStyle(n).backgroundColor));
    const off = await surface();
    await second.locator("button").click();
    await page.waitForTimeout(900);
    const on = await surface();
    check("selecting a tool changes how it looks", off[1] !== on[1], `${off[1]} -> ${on[1]}`);
    check("and leaves the other one alone", off[0] === on[0], String(off[0]));

    // Selected and unselected have to be the same box, or the row jumps by the
    // border every time somebody presses one. Measured with one on and one off,
    // since two of the same variant agree about their height however wrong it is.
    await second.locator("button").click();
    await page.waitForTimeout(900);
    const boxes = await page.locator("#toolToggle button").evaluateAll((nodes) =>
      nodes.map((n) => Math.round(n.getBoundingClientRect().height)));
    check("selected and unselected sit at the same height", new Set(boxes).size === 1, boxes.join(","));
  } else {
    check("tool toggle has choices", false, `only ${await buttons.count()}`);
  }

  await page.click('[data-testid="settings-button"]');
  await page.waitForTimeout(900);
  check("settings panel opens", await page.locator("#settings").isVisible());
  check("settings names the project", (await page.locator('[data-testid="set-project"]').inputValue()).includes("project"));
  check("settings probes targets", (await page.locator('[data-testid="settings-targets"] [data-testid="settings-target"]').count()) > 0);
  await checkAccessibility("settings");

  // Pointing the page at another project, which is the one control here that
  // changes what every other area is about. The native chooser beside it is
  // deliberately never clicked: it is a modal the SERVER opens, and a driver
  // that pressed it would block this run until somebody came and dismissed it.
  check("the folder chooser is offered", await page.locator('[data-testid="pick-project"]').isVisible());

  // The calls-to-action consent, which lives in this panel. What it has to do
  // is agree with the server: it is consent to click the application's own
  // controls, so a page showing it on while the server has it off would
  // authorize a run nobody asked for, and one showing it off while the server
  // has it on would hide one.
  const nav = page.locator('[data-testid="nav-toggle"]');
  const navState = page.locator("#setNavState");
  check("the CTA consent is in the settings panel", await nav.isVisible());
  check("the CTA consent starts off", (await nav.getAttribute("aria-checked")) === "false");
  check("and says so in words", ((await navState.textContent()) ?? "").toLowerCase().includes("off"));
  await nav.click();
  await page.waitForTimeout(900);
  check("clicking it turns it on", (await nav.getAttribute("aria-checked")) === "true");
  check("the row says it is on", ((await navState.textContent()) ?? "").toLowerCase().includes("on"));
  // What play is about to spend is readable from play itself, which is the one
  // control still on screen once this panel is shut.
  check(
    "play says the run will click things",
    ((await page.locator('[data-testid="find-fix"]').getAttribute("aria-label")) ?? "").includes("Calls to action are ON"),
  );
  // The judge's model, which is the other thing in this panel that a run
  // actually spends. The failure worth catching is the panel and the server
  // disagreeing: a box showing a model the next run will not use files its
  // verdicts in the ledger under a name nobody chose.
  const modelMenu = page.locator('[data-testid="model-menu-claude-code"]');
  const modelBox = page.locator('[data-testid="model-input-claude-code"]');
  const openModelMenu = async (): Promise<void> => {
    await modelMenu.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    await modelMenu.click();
    await page.getByRole("option").first().waitFor({ state: "visible" });
  };
  const judgeModel = async (): Promise<string | null | undefined> => {
    const res = await page.request.get(url + "api/settings");
    const judges = ((await res.json()) as { judges?: { key: string; model: string | null }[] }).judges ?? [];
    return judges.find((j) => j.key === "claude-code")?.model;
  };
  const save = async (): Promise<void> => {
    await page.locator('[data-testid="save-model-claude-code"]').click();
    await page.waitForTimeout(900);
  };
  check("a model row is offered for the judge", await modelMenu.isVisible());
  // The names in it are the installed CLI's, not lookout's. Asserting a
  // specific one would bake in the very list this menu exists to avoid, so what
  // is checked is that the CLI answered with some names and that the menu
  // starts on lookout's default rather than on one of them.
  await openModelMenu();
  const names = await page.getByRole("option").allTextContents();
  check("the menu carries names the installed CLI offered", names.length > 2, names.join(","));
  await page.getByRole("option").first().click();
  await page.waitForTimeout(400);
  check("and it starts on lookout's own default", ((await modelMenu.textContent()) ?? "").includes("lookout's default"), names.join(","));
  check(
    "the version of the CLI those names came from is under the menu",
    await page.locator('[data-testid="judge-version"]').filter({ hasText: "Claude Code" }).isVisible(),
  );
  // A name from the menu: the failure worth catching is the panel and the
  // server disagreeing, because a menu showing a model the next run will not
  // use files its verdicts in the ledger under a name nobody chose.
  const offered = (names[1] ?? "").trim();
  await openModelMenu();
  await page.getByRole("option", { name: offered, exact: true }).click();
  await page.waitForTimeout(400);
  await save();
  check("the server took the model the menu was saved with", (await judgeModel()) === offered, offered);
  // A name the menu does not offer, which is what Custom is for: judging that
  // has to stay reproducible across a CLI upgrade needs a pinned full name, and
  // a menu that could not accept one would take away what the box could do.
  // Picked by the label a person reads rather than by the value behind it: the
  // sentinel is the page's private business, and driving it by label is both
  // what somebody actually does and one less thing for the two to disagree on.
  await openModelMenu();
  await page.getByRole("option", { name: "Custom...", exact: true }).click();
  await page.waitForTimeout(400);
  check("picking Custom reveals a box to type a name into", await modelBox.isVisible());
  await modelBox.fill("claude-pinned-9-9");
  await save();
  check("the server took a name the menu never offered", (await judgeModel()) === "claude-pinned-9-9");
  // And that name comes back as Custom rather than being silently dropped: it
  // is not in the menu, so the row has to remember which control it belongs in.
  await page.reload({ waitUntil: "networkidle" });
  await page.click('[data-testid="settings-button"]');
  await page.waitForTimeout(900);
  check("a pinned name comes back in the box, not lost to the menu", await modelBox.isVisible());
  check("with the box holding it", (await modelBox.inputValue()) === "claude-pinned-9-9");
  await openModelMenu();
  await page.getByRole("option", { name: /lookout's default/, exact: false }).click();
  await page.waitForTimeout(400);
  await save();
  check("and choosing lookout's default puts it back", (await judgeModel()) === null);

  const consent = await page.request.get(url + "api/settings");
  check(
    "the server agrees it is on",
    ((await consent.json()) as { navigation?: boolean }).navigation === true,
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  // The panel is shut again after a reload, so the consent has to be found the
  // way a person finds it.
  check("the CTA consent is not on the page until the cog is opened", !(await nav.isVisible()));
  await page.click('[data-testid="settings-button"]');
  await page.waitForTimeout(900);
  check("consent outlives a reload", (await nav.getAttribute("aria-checked")) === "true");
  await nav.click();
  await page.waitForTimeout(900);
  check("clicking it again withdraws it", (await nav.getAttribute("aria-checked")) === "false");
  check(
    "and the server agrees it is off",
    ((await (await page.request.get(url + "api/settings")).json()) as { navigation?: boolean })
      .navigation === false,
  );
  // The way out of the panel. The cog is the only control that opens it, so
  // while it is open the cog is also the only obvious way back, and a button
  // still labelled "Settings" beside an open settings panel does not read as
  // one. Escape is what people try first, and it used to fall straight past
  // this panel to the filter underneath.
  check(
    "the cog says what it will do while the panel is open",
    (await page.locator('[data-testid="settings-button"]').getAttribute("aria-label")) === "Close settings",
    (await page.locator('[data-testid="settings-button"]').getAttribute("aria-label")) ?? "",
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  check("escape dismisses the settings panel", !(await page.locator("#settings").isVisible()));
  check(
    "and the cog offers to open it again",
    (await page.locator('[data-testid="settings-button"]').getAttribute("aria-label")) === "Settings",
  );

  // Canvas owns the drawer's scrim and event capture. Exercise its two useful
  // boundaries: presses inside stay inside, while a scrim press closes the
  // drawer without activating the board underneath it.
  const openPanel = async (label: string): Promise<void> => {
    if (await page.locator('[data-testid="confirm"]').isVisible()) await page.getByRole("button", { name: "Cancel" }).click();
    if (!(await page.locator("#viewIssues").isVisible())) {
      await page.click('[data-testid="area-issues"]');
      await page.waitForTimeout(500);
    }
    if (!(await page.locator("#settings").isVisible())) await page.click('[data-testid="settings-button"]');
    await page.waitForTimeout(700);
    check(`the panel is open for ${label}`, await page.locator("#settings").isVisible());
  };

  await openPanel("the click inside it");
  await page.locator("#settings h2").click();
  await page.waitForTimeout(500);
  check("a click inside the panel leaves it open", await page.locator("#settings").isVisible());

  const tabsBefore = page.context().pages().length;
  const drawer = page.locator('[data-testid="settings-drawer"]');
  const drawerBox = await drawer.boundingBox();
  await drawer.click({ position: { x: Math.max(1, (drawerBox?.width ?? 1440) - 8), y: 300 } });
  await page.waitForTimeout(700);
  check("a scrim click dismisses the panel", !(await page.locator("#settings").isVisible()));
  check("the scrim does not activate the board", !(await page.locator("#filterbar").isVisible()));
  check("the scrim opens no new tab", page.context().pages().length === tabsBefore);

  await openPanel("the prompt");
  await page.click('[data-testid="reset-project"]');
  await page.waitForTimeout(600);
  check("the destructive prompt opens", await page.getByText("Delete everything lookout found?", { exact: true }).isVisible());
  check("the drawer yields focus to the prompt", !(await page.locator("#settings").isVisible()));
  await page.getByText("Delete everything lookout found?", { exact: true }).click();
  await page.waitForTimeout(400);
  check(
    "a click on the prompt leaves the prompt open",
    await page.getByText("Delete everything lookout found?", { exact: true }).isVisible(),
  );
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(500);
  check("cancelling returns to settings", await page.locator("#settings").isVisible());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // The fold. What it has to actually do is give the width back: a column that
  // narrows while the board keeps its old padding is a stripe of empty page,
  // and nothing but a measurement catches that.
  const widthOf = async (sel: string): Promise<number> =>
    (await page.locator(sel).boundingBox())?.width ?? -1;
  const railWide = await widthOf('nav[aria-label="Areas"]');
  const openWide = await widthOf("#stream");
  const workspaceWide = await widthOf("#workspace");
  check("the judge's column starts open", openWide > railWide * 2, `${openWide}px`);
  await page.click('[data-testid="judge-fold"]');
  await page.waitForTimeout(400);
  check("folding narrows it to the rail's width", (await widthOf("#stream")) === railWide,
    `${await widthOf("#stream")}px vs rail ${railWide}px`);
  check("the transcript goes with it", !(await page.locator('[data-testid="stream-log"]').isVisible()));
  // The queue is the second half of this column now, and a section that failed
  // to fold would paint its rows on top of the fold button in a 56px strip.
  check("the queue goes with it", !(await page.locator('[data-testid="queue-list"]').isVisible()));
  check("the board takes the width back", (await widthOf("#workspace")) === workspaceWide + openWide - railWide);
  check("the way back out is still there", await page.locator('[data-testid="judge-fold"]').isVisible());
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check("the fold is remembered", (await widthOf("#stream")) === railWide);
  await page.click('[data-testid="judge-fold"]');
  await page.waitForTimeout(400);
  check("unfolding puts the transcript back", await page.locator('[data-testid="stream-log"]').isVisible());
  check("and the queue with it", await page.locator('[data-testid="queue-list"]').isVisible());
  check("and the column with it", (await widthOf("#stream")) === openWide);

  // The queue. What it has to do is come back with fewer rows when the X is
  // pressed, and let a card's play button put one in without opening anything.
  const qrows = async (): Promise<number> => page.locator('[data-testid="queue-list"] [data-testid="queue-row"]').count();
  const queued = await qrows();
  check("the queue has rows", queued > 0, `${queued}`);
  check("the head is marked as the one being worked on",
    (await page.locator('[data-testid="queue-list"] [data-testid="queue-row"][data-head="true"]').count()) === 1);
  check("a handoff that failed says why",
    (await page.locator('[data-testid="queue-list"] [data-testid="queue-row"][data-failed="true"] [data-testid="queue-state"]').first().innerText()).length > 0);
  check("the head offers to have lookout rule on it",
    (await page.locator('[data-testid="queue-list"] [data-testid="queue-row"][data-head="true"] [data-testid^="rule-"]').count()) === 1);
  await page.locator('[data-testid="queue-list"] [data-testid="queue-row"] [data-testid^="remove-"]').first().click();
  await page.waitForTimeout(1800);
  check("the X takes a row out", (await qrows()) === queued - 1, `${await qrows()} vs ${queued}`);
  check("and the count follows",
    (await page.locator("#queueCount").innerText()).trim() === String(queued - 1));

  // Pressing play queues rather than launching: the row count goes up, and the
  // card's own button comes back pressed.
  const card = page.locator('[data-testid="issue-card"] [data-testid^="queue-"]').first();
  if (await card.count()) {
    const id = (await card.getAttribute("data-testid"))?.replace("queue-", "") ?? null;
    const was = await qrows();
    await card.click();
    await page.waitForTimeout(1800);
    check("pressing play adds a row rather than opening anything", (await qrows()) === was + 1,
      `${await qrows()} vs ${was}`);
    check("and the card's button comes back pressed",
      (await page.locator(`[data-testid="unqueue-${id}"]`).count()) === 1);
  }

  await page.click('[data-testid="area-learning"]');
  await page.waitForTimeout(1200);
  check("learning area shows", await page.locator("#learning").isVisible());
  check("issues area hides", !(await page.locator("#viewIssues").isVisible()));
  check("headline numbers hide with the board", !(await page.locator("#stats").isVisible()));
  check("learning history rendered", (await page.locator('[data-testid="learning-history"] [data-testid="learning-entry"]').count()) > 0);
  check("skills rendered", (await page.locator('[data-testid="learning-skills"] [data-testid="learning-skill"]').count()) > 0);
  await checkAccessibility("learning");
  await page.click('[data-testid="area-issues"]');
  await page.waitForTimeout(600);
  check("issues area comes back", await page.locator("#viewIssues").isVisible());

  // The shot inspector: a plain click on any tile opens the lightbox instead
  // of navigating; a modified click keeps the anchor's own behavior. The
  // sidecar-carrying tile is the archived card's live strip (frames are
  // copies and never advertise), so the filter comes first.
  check("tiles carry the inspector's data", (await page.locator('[data-testid="shot-prov"], [data-testid="shot-bare"]').count()) > 0);
  await page.click('[data-testid="stat-archived"]');
  await page.waitForTimeout(1200);
  const provTile = page.locator('[data-testid="shot-prov"]').first();
  check("the fixture advertises one sidecar", (await page.locator('[data-testid="shot-prov"]').count()) > 0);
  check("tiles keep their evidence href", ((await provTile.getAttribute("href")) ?? "").startsWith("/evidence/"));
  await provTile.click();
  await page.waitForTimeout(800);
  check("clicking a tile opens the inspector", await page.locator("#shotview").isVisible());
  check(
    "the inspector loads the full image",
    await page.locator('[data-testid="shot-image"] img, img[data-testid="shot-image"]').evaluate((n) => (n as HTMLImageElement).naturalWidth > 0),
  );
  check("every projectable element gets a box", (await page.locator('[data-testid="shot-box"]').count()) === 4);
  await page.click('[data-testid="shot-box"][aria-label*="Heading.tsx"]');
  check(
    "pinning a box names its component and source",
    ((await page.locator("#svHint").textContent()) ?? "").includes(
      "Heading < Page  src/components/Heading.tsx:12  h1#title",
    ),
  );
  await page.click('[data-testid="shot-box"][aria-label^="main > p:nth-of-type(2)"]');
  check(
    "a box with neither component nor source falls back to its cssPath",
    ((await page.locator("#svHint").textContent()) ?? "").includes("main > p:nth-of-type(2)"),
  );
  // The explicit close controls and Escape all work. Canvas keeps a modal open
  // on scrim clicks, which prevents an inspection from being lost accidentally.
  await page.click('[data-testid="shot-close"]');
  await page.waitForTimeout(400);
  check("the close button closes the inspector", !(await page.locator("#shotview").isVisible()));
  await provTile.click();
  await page.waitForTimeout(600);
  await page.click('[data-testid="shot-corner-close"]');
  await page.waitForTimeout(400);
  check("the picture's own corner button closes it", !(await page.locator("#shotview").isVisible()));
  await provTile.click();
  await page.waitForTimeout(600);
  // Inside the body's padding, so the click lands on the scrim rather than on
  // the picture or any of its boxes.
  await page.getByRole("dialog", { name: "Screenshot provenance inspector" }).click({ position: { x: 8, y: 8 } });
  await page.waitForTimeout(400);
  check("clicking the scrim leaves the inspector open", await page.locator("#shotview").isVisible());
  await page.locator('[data-testid="shot-image"]').click();
  await page.waitForTimeout(300);
  check("clicking the picture itself does not close it", await page.locator("#shotview").isVisible());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check("escape closes the inspector", !(await page.locator("#shotview").isVisible()));
  check("closing it leaves the filter alone", await page.locator("#filterbar").isVisible());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1200);
  check("a second escape clears the filter and restores the board", (await shown()).join() === before.join());

  // The light shot deliberately has no sidecar: the inspector still opens as
  // a plain lightbox and says so, without ever fetching (a 404 would land in
  // this drive's own console-error net).
  const bareTile = page.locator('[data-testid="shot-bare"]').first();
  if ((await bareTile.count()) > 0) {
    await bareTile.click();
    await page.waitForTimeout(600);
    check(
      "a shot without provenance says so",
      ((await page.locator("#svHint").textContent()) ?? "").includes("no provenance recorded"),
    );
    check("and renders no boxes", (await page.locator('[data-testid="shot-box"]').count()) === 0);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  } else {
    check("a sidecar-less tile exists to test the bare path", false);
  }

  // Last on purpose. Pointing the page at another project reloads the board,
  // the queue and the transcript, so any check that ran after this one would be
  // asserting against a page that had just been rebuilt underneath it.
  await page.click('[data-testid="settings-button"]');
  await page.waitForTimeout(600);
  const served = await page.locator('[data-testid="set-project"]').inputValue();
  const setProjectTo = async (dir: string) => {
    await page.fill('[data-testid="set-project"]', dir);
    await page.press('[data-testid="set-project"]', "Enter");
    await page.waitForTimeout(900);
  };

  // Asking for a directory that is no project is answered 400, which reaches
  // the browser console as a failed fetch. That is the shape of a refusal
  // working, so the entries this one check provokes are dropped rather than
  // left to fail the watch that exists to catch the unexpected ones.
  const noiseFrom = problems.length;
  await setProjectTo("/nowhere/no/such/project");
  problems.splice(
    noiseFrom,
    problems.length - noiseFrom,
    ...problems.slice(noiseFrom).filter((entry) => !/status of 400/.test(entry)),
  );
  check("a path that is no project is refused",
    (await page.locator("#where").getAttribute("data-notice")) === "true");
  // The box keeps the rejected text on purpose, so a typo can be corrected
  // rather than retyped; what must not have moved is the server.
  check("and the page is still serving what it was",
    ((await (await page.request.get(url + "api/status")).json()) as { projectDir?: string }).projectDir === served);

  await setProjectTo(served);
  check("re-pointing at the project it already serves is accepted",
    (await page.locator("#where").getAttribute("data-notice")) === "false");
  check("and it still names that project", (await page.locator('[data-testid="set-project"]').inputValue()) === served);

  console.log(problems.length ? `\nPROBLEMS:\n${problems.join("\n")}` : "\nno page or console errors");
  return failed + problems.length;
}

/** Own the Playwright resources independently of every interaction assertion. */
async function drive(): Promise<number> {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ colorScheme: "dark", viewport: { width: 1440, height: 950 } });
    try {
      return await drivePage(await ctx.newPage());
    } finally {
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

const [command, a, b] = process.argv.slice(2);

if (command === "fixture") {
  const paths = await buildFixture(join(WORK, "fixture"));
  console.log(`fixture built:\n  project  ${paths.project}\n  checkout ${paths.checkout}`);
} else if (command === "serve") {
  const { project } = fixturePaths();
  if (!existsSync(project)) {
    console.error("no fixture yet: run `bun tools/ui-check/run.ts fixture` first");
    process.exit(2);
  }
  // Inherit stdio so the ui's own startup lines are visible; this blocks.
  const child = startServer();
  process.on("SIGINT", () => child.kill("SIGINT"));
  await waitForServer(child);
  await waitUntilExit(child);
} else if (command === "shots") {
  process.exit((await shots(a ?? "shots")) === 0 ? 0 : 1);
} else if (command === "diff") {
  if (!a || !b) {
    console.error("diff needs two labels, e.g. `diff before after`");
    process.exit(2);
  }
  process.exit((await diff(a, b)) === 0 ? 0 : 1);
} else if (command === "drive") {
  process.exit((await drive()) === 0 ? 0 : 1);
} else if (command === "ci") {
  process.exit((await ci()) === 0 ? 0 : 1);
} else {
  console.log("usage: bun tools/ui-check/run.ts <fixture|serve|shots <label>|diff <a> <b>|drive|ci>");
  process.exit(2);
}
