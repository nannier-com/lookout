#!/usr/bin/env bun
/**
 * The gate for anything `lookout ui` renders.
 *
 * Type checks and tests say nothing about what a browser draws. Three real bugs
 * in this repo passed every other gate and were caught here: a filter bar with
 * no `[hidden]` rule that could not be hidden, and two optional fields
 * dereferenced after being guarded on a copy.
 *
 * Four commands, meant to bracket a change: `fixture` builds a throwaway
 * project with something in every part of the page, `serve` points the ui at
 * it, `shots` captures a fixed set of views, `diff` compares two captures pixel
 * by pixel, and `drive` clicks through the page and asserts what should happen.
 *
 * See README.md beside this file for the order to run them in.
 */
import { chromium, type Page } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildFixture } from "./fixture.js";
import { changeSaid, diffPng, writeDiffCrop } from "../../src/verify/pixels.js";

const ROOT = join(import.meta.dir, "..", "..");
const WORK = join(ROOT, ".lookout-ui-check");
const PORT = Number(process.env.UI_CHECK_PORT ?? 7399);
const URL = `http://127.0.0.1:${PORT}/`;

function fixturePaths(): { project: string; home: string; checkout: string } {
  return {
    project: join(WORK, "fixture", "project"),
    home: join(WORK, "fixture", "home"),
    checkout: join(WORK, "fixture", "checkout"),
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
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`${name}: ${String(e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`${name}: console ${m.text()}`);
  });
  await page.goto(URL, { waitUntil: "networkidle" });
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
  await ctx.close();
}

async function shots(label: string): Promise<void> {
  const out = join(WORK, "shots", label);
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const problems: string[] = [];
  const nothing = async (): Promise<void> => {};
  await view(browser, out, "board-dark", "dark", 1440, 950, nothing, problems);
  await view(browser, out, "board-light", "light", 1440, 950, nothing, problems);
  await view(browser, out, "board-narrow", "light", 430, 900, nothing, problems);
  await view(browser, out, "board-filtered", "dark", 1440, 950, (p) => p.click('button.stat[data-value="archived"]'), problems);
  // The settled issue, which is the only card carrying both halves of a pre and
  // post fix pair. It is filtered off the default board, so without this view
  // the comparison the page exists to show is never captured.
  await view(browser, out, "board-done", "dark", 1440, 950, (p) => p.click('button.stat[data-value="done"]'), problems);
  await view(browser, out, "settings-open", "dark", 1440, 950, (p) => p.click("#cog"), problems);
  // The judge's column folded away. A state the page can be left in, so it is a
  // state the gate has to have a picture of: the strip at the edge and the
  // board's new width are both things only a capture shows.
  await view(browser, out, "judge-shut", "dark", 1440, 950, (p) => p.click("#streamFold"), problems);
  await view(browser, out, "learning-dark", "dark", 1440, 950, (p) => p.click('[data-view="learning"]'), problems);
  await view(browser, out, "learning-light", "light", 1440, 950, (p) => p.click('[data-view="learning"]'), problems);
  await view(browser, out, "learning-narrow", "dark", 430, 900, (p) => p.click('[data-view="learning"]'), problems);
  // The shot inspector over the one fixture shot that carries a sidecar: the
  // archived card's live tile (cards with frozen frames show the frames,
  // which are copies and never advertise). Deterministic because the hint is
  // painted on open and a box is clicked rather than hovered.
  const openTile = async (p: Page): Promise<void> => {
    await p.click('button.stat[data-value="archived"]');
    await p.click("a.tile[data-prov]");
    await p.waitForTimeout(400);
    await p.click('.svbox[aria-label*="Heading.tsx"]');
  };
  await view(browser, out, "shot-overlay-dark", "dark", 1440, 950, openTile, problems);
  await view(browser, out, "shot-overlay-light", "light", 1440, 950, openTile, problems);
  await view(browser, out, "shot-overlay-narrow", "dark", 430, 900, openTile, problems);
  await browser.close();
  console.log(`${label}: ${readdirSync(out).filter((n) => n.endsWith(".png")).length} views in ${out}`);
  console.log(problems.length ? `PROBLEMS:\n${problems.join("\n")}` : "no page or console errors");
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
async function drive(): Promise<number> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ colorScheme: "dark", viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${String(e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);

  let failed = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) failed++;
    console.log(`${ok ? "pass  " : "FAIL  "}${name}${detail ? `  ${detail}` : ""}`);
  };
  const shown = (): Promise<string[]> => page.locator("article.card .issueid").allTextContents();

  const before = await shown();
  check("board renders cards", before.length > 0, `ids=${before.join(",")}`);

  // The document link, on every card, followed rather than counted. A card
  // linking a 404 is indistinguishable from one linking a document until
  // somebody clicks it, and the URL is spelled in the client and matched in the
  // server, so the only check worth making is whether the file comes back.
  const docs = page.locator("article.card a.doc");
  const links = await docs.count();
  check("every card links its document", links === before.length, `${links} links for ${before.length} cards`);
  const href = links > 0 ? await docs.first().getAttribute("href") : null;
  const doc = href ? await page.request.get(URL + href.replace(/^\//, "")) : null;
  check("the document link resolves", doc?.status() === 200, `${href} -> ${doc?.status() ?? "not requested"}`);
  const text = doc ? await doc.text() : "";
  check("what comes back is that issue's document", text.includes(`issue:      ${before[0]}`), text.slice(0, 40));

  // The fixture has one issue in each of open, adjudicated and settled, and the
  // board shows one status at a time, so what a filter changes is which card is
  // on the board, not how many.
  await page.click('button.stat[data-value="archived"]');
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

  const buttons = page.locator("#toolToggle button");
  if ((await buttons.count()) > 1) {
    const second = buttons.nth(1);
    const key = await second.getAttribute("data-tool");
    await second.click();
    await page.waitForTimeout(1200);
    check("tool choice sticks", (await second.getAttribute("aria-pressed")) === "true", String(key));
    check("tool choice is remembered", (await page.evaluate(() => localStorage.getItem("lookout.tool"))) === key);
  } else {
    check("tool toggle has choices", false, `only ${await buttons.count()}`);
  }

  await page.click("#cog");
  await page.waitForTimeout(900);
  check("settings panel opens", await page.locator("#settings").isVisible());
  check("settings names the project", ((await page.locator("#setProject").textContent()) ?? "").includes("project"));
  check("settings probes targets", (await page.locator("#setTargets .tgt").count()) > 0);

  // The calls-to-action consent, which lives in this panel. What it has to do
  // is agree with the server: it is consent to click the application's own
  // controls, so a page showing it on while the server has it off would
  // authorize a run nobody asked for, and one showing it off while the server
  // has it on would hide one.
  const nav = page.locator("#navToggle");
  const navState = page.locator("#setNavState");
  check("the CTA consent is in the settings panel", await nav.isVisible());
  check("the CTA consent starts off", (await nav.getAttribute("aria-pressed")) === "false");
  check("and says so in words", ((await navState.textContent()) ?? "").toLowerCase().includes("off"));
  await nav.click();
  await page.waitForTimeout(900);
  check("clicking it turns it on", (await nav.getAttribute("aria-pressed")) === "true");
  check("the row says it is on", ((await navState.textContent()) ?? "").toLowerCase().includes("on"));
  // What play is about to spend is readable from play itself, which is the one
  // control still on screen once this panel is shut.
  check(
    "play says the run will click things",
    ((await page.locator("#findfix").getAttribute("title")) ?? "").includes("Calls to action are ON"),
  );
  const consent = await page.request.get(URL + "api/settings");
  check(
    "the server agrees it is on",
    ((await consent.json()) as { navigation?: boolean }).navigation === true,
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  // The panel is shut again after a reload, so the consent has to be found the
  // way a person finds it.
  check("the CTA consent is not on the page until the cog is opened", !(await nav.isVisible()));
  await page.click("#cog");
  await page.waitForTimeout(900);
  check("consent outlives a reload", (await nav.getAttribute("aria-pressed")) === "true");
  await nav.click();
  await page.waitForTimeout(900);
  check("clicking it again withdraws it", (await nav.getAttribute("aria-pressed")) === "false");
  check(
    "and the server agrees it is off",
    ((await (await page.request.get(URL + "api/settings")).json()) as { navigation?: boolean })
      .navigation === false,
  );
  await page.click("#cog");

  // The fold. What it has to actually do is give the width back: a column that
  // narrows while the board keeps its old padding is a stripe of empty page,
  // and nothing but a measurement catches that.
  const widthOf = async (sel: string): Promise<number> =>
    (await page.locator(sel).boundingBox())?.width ?? -1;
  const railWide = await widthOf(".rail");
  const openWide = await widthOf(".stream");
  check("the judge's column starts open", openWide > railWide * 2, `${openWide}px`);
  await page.click("#streamFold");
  await page.waitForTimeout(400);
  check("folding narrows it to the rail's width", (await widthOf(".stream")) === railWide,
    `${await widthOf(".stream")}px vs rail ${railWide}px`);
  check("the transcript goes with it", !(await page.locator("#streamLog").isVisible()));
  check("the board takes the width back",
    (await page.evaluate(() => getComputedStyle(document.body).paddingRight)) === `${railWide}px`);
  check("the way back out is still there", await page.locator("#streamFold").isVisible());
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  check("the fold is remembered", (await widthOf(".stream")) === railWide);
  await page.click("#streamFold");
  await page.waitForTimeout(400);
  check("unfolding puts the transcript back", await page.locator("#streamLog").isVisible());
  check("and the column with it", (await widthOf(".stream")) === openWide);

  await page.click('[data-view="learning"]');
  await page.waitForTimeout(1200);
  check("learning area shows", await page.locator("#learning").isVisible());
  check("issues area hides", !(await page.locator("#viewIssues").isVisible()));
  check("headline numbers hide with the board", !(await page.locator("#stats").isVisible()));
  check("learning history rendered", (await page.locator("#lhistory .lentry").count()) > 0);
  check("skills rendered", (await page.locator("#lskills .skill").count()) > 0);
  await page.click('[data-view="issues"]');
  await page.waitForTimeout(600);
  check("issues area comes back", await page.locator("#viewIssues").isVisible());

  // The shot inspector: a plain click on any tile opens the lightbox instead
  // of navigating; a modified click keeps the anchor's own behavior. The
  // sidecar-carrying tile is the archived card's live strip (frames are
  // copies and never advertise), so the filter comes first.
  check("tiles carry the inspector's data", (await page.locator("a.tile[data-shot]").count()) > 0);
  await page.click('button.stat[data-value="archived"]');
  await page.waitForTimeout(1200);
  const provTile = page.locator("a.tile[data-prov]").first();
  check("the fixture advertises one sidecar", (await page.locator("a.tile[data-prov]").count()) > 0);
  check("tiles keep their evidence href", ((await provTile.getAttribute("href")) ?? "").startsWith("/evidence/"));
  await provTile.click();
  await page.waitForTimeout(800);
  check("clicking a tile opens the inspector", await page.locator("#shotview").isVisible());
  check(
    "the inspector loads the full image",
    await page.locator("#svImg").evaluate((n) => (n as HTMLImageElement).naturalWidth > 0),
  );
  check("every projectable element gets a box", (await page.locator(".svbox").count()) === 4);
  await page.click('.svbox[aria-label*="Heading.tsx"]');
  check(
    "pinning a box names its component and source",
    ((await page.locator("#svHint").textContent()) ?? "").includes(
      "Heading < Page  src/components/Heading.tsx:12  h1#title",
    ),
  );
  await page.click('.svbox[aria-label^="main > p:nth-of-type(2)"]');
  check(
    "a box with neither component nor source falls back to its cssPath",
    ((await page.locator("#svHint").textContent()) ?? "").includes("main > p:nth-of-type(2)"),
  );
  // Four ways out, and all four are checked: the drive used to press Escape
  // only, which is how an overlay nobody could dismiss by clicking shipped.
  await page.click("#svClose");
  await page.waitForTimeout(400);
  check("the close button closes the inspector", !(await page.locator("#shotview").isVisible()));
  await provTile.click();
  await page.waitForTimeout(600);
  await page.click("#svX");
  await page.waitForTimeout(400);
  check("the picture's own corner button closes it", !(await page.locator("#shotview").isVisible()));
  await provTile.click();
  await page.waitForTimeout(600);
  // Inside the body's padding, so the click lands on the scrim rather than on
  // the picture or any of its boxes.
  await page.locator("#svBody").click({ position: { x: 8, y: 8 } });
  await page.waitForTimeout(400);
  check("clicking the scrim closes the inspector", !(await page.locator("#shotview").isVisible()));
  await provTile.click();
  await page.waitForTimeout(600);
  await page.locator("#svImg").click();
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
  const bareTile = page.locator("a.tile[data-shot]:not([data-prov])").first();
  if ((await bareTile.count()) > 0) {
    await bareTile.click();
    await page.waitForTimeout(600);
    check(
      "a shot without provenance says so",
      ((await page.locator("#svHint").textContent()) ?? "").includes("no provenance recorded"),
    );
    check("and renders no boxes", (await page.locator(".svbox").count()) === 0);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  } else {
    check("a sidecar-less tile exists to test the bare path", false);
  }

  console.log(problems.length ? `\nPROBLEMS:\n${problems.join("\n")}` : "\nno page or console errors");
  await browser.close();
  return failed + problems.length;
}

const [command, a, b] = process.argv.slice(2);

if (command === "fixture") {
  const paths = await buildFixture(join(WORK, "fixture"));
  console.log(`fixture built:\n  project  ${paths.project}\n  home     ${paths.home}\n  checkout ${paths.checkout}`);
} else if (command === "serve") {
  const { project, home, checkout } = fixturePaths();
  if (!existsSync(project)) {
    console.error("no fixture yet: run `bun tools/ui-check/run.ts fixture` first");
    process.exit(2);
  }
  // Inherit stdio so the ui's own startup lines are visible; this blocks.
  const child = spawn(process.execPath, [join(ROOT, "src", "cli.ts"), "ui", "--port", String(PORT)], {
    cwd: project,
    env: { ...process.env, LOOKOUT_HOME: home, LOOKOUT_CHECKOUT: checkout },
    stdio: "inherit",
  });
  process.on("SIGINT", () => child.kill("SIGINT"));
  await new Promise((done) => child.on("exit", done));
} else if (command === "shots") {
  await shots(a ?? "shots");
} else if (command === "diff") {
  if (!a || !b) {
    console.error("diff needs two labels, e.g. `diff before after`");
    process.exit(2);
  }
  process.exit((await diff(a, b)) === 0 ? 0 : 1);
} else if (command === "drive") {
  process.exit((await drive()) === 0 ? 0 : 1);
} else {
  console.log("usage: bun tools/ui-check/run.ts <fixture|serve|shots <label>|diff <a> <b>|drive>");
  process.exit(2);
}
