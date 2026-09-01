/**
 * A project on disk with a plausible past, so the page has something to draw.
 *
 * Everything the ui can show is represented: an open issue with evidence and
 * acceptance criteria, one adjudicated as intentional, a history of lookout
 * amending its own instructions including a rollback, a frozen set to gate the
 * next amendment, a machine-wide incident log, a reverted self-heal attempt and
 * a checkout with two heals that stuck. Without all of that a screenshot proves
 * only that the empty states render.
 *
 * Timestamps are fixed in the past on purpose. The one clock the page shows is
 * a relative "seen" time, and everything else has to be stable or a pixel
 * comparison between two runs is meaningless.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { workspaceKey } from "../../src/home.js";

const AT = "2026-08-28T14:02:11.000Z";

/**
 * Issue ids, fixed rather than minted.
 *
 * lookout draws an id at random the first time it sees a cluster key, and a
 * random number on a card is a hundred pixels that differ between two captures
 * of the same page. Seeding the records means the fixture also owns the frames
 * frozen under each id.
 */
const OPEN_ISSUE = "418203";
const INTENTIONAL_ISSUE = "552140";
const SETTLED_ISSUE = "731094";

/**
 * The age of the evidence, frozen.
 *
 * The one clock the page shows is "seen <duration>", derived from the mtime of
 * the newest screenshot an issue was filed against. Left alone that advances in
 * real time, so two captures minutes apart differ by a hundred pixels of digits
 * and every comparison becomes a judgement call about whether that was the
 * clock. Backdated far enough that the duration renders in whole days, it only
 * moves once a day, and a refactor that changed nothing reads as identical.
 */
const EVIDENCE_MTIME = new Date("2025-01-01T00:00:00.000Z");

/**
 * A page-shaped image, so a thumbnail looks like a screenshot of something.
 *
 * `overflow` draws a block running off the right edge, which is what the pre
 * and post frames of the settled issue differ by: a pair whose halves are the
 * same picture proves the layout renders but not that it is showing two
 * different moments.
 */
async function shot(path: string, bg: string, bar: string, overflow = false): Promise<void> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="900">
      <rect width="1280" height="900" fill="${bg}"/>
      <rect x="0" y="0" width="1280" height="72" fill="${bar}"/>
      <rect x="40" y="140" width="520" height="34" rx="8" fill="#8b8f99" opacity="0.45"/>
      <rect x="40" y="200" width="900" height="18" rx="6" fill="#8b8f99" opacity="0.3"/>
      <rect x="40" y="232" width="820" height="18" rx="6" fill="#8b8f99" opacity="0.3"/>
      <rect x="40" y="300" width="${overflow ? 1500 : 300}" height="120" rx="12" fill="#8b8f99" opacity="0.2"/>
    </svg>`,
  );
  await sharp(svg).png().toFile(path);
}

function finding(over: Record<string, unknown>): Record<string, unknown> {
  return {
    target: "app",
    route: "/",
    state: "rest",
    platform: "web",
    formFactor: "desktop",
    scheme: "dark",
    severity: "high",
    channel: "ai",
    confidence: "high",
    verified: true,
    acceptance: [],
    firstSeen: AT,
    lastSeen: AT,
    evidence: [
      { shotId: "web/app/root/rest/desktop/dark", path: "web/app/root/rest--desktop-dark.png", hash: "h1", at: AT },
    ],
    ...over,
  };
}

/**
 * One issue's frozen frames: the images in its own folder, and the manifest
 * the page reads.
 *
 * Written by hand because the fixture has no run behind it. What the card
 * draws is this manifest, so this is the shape a real freeze leaves on disk:
 * the pixels under `img/pre|post/`, `frames.json` beside the record.
 */
async function freeze(
  lk: string,
  id: string,
  sides: readonly {
    side: "before" | "after";
    file: string;
    route: string;
    formFactor: string;
    overflow: boolean;
  }[],
): Promise<void> {
  const manifest: { schema: 2; before: unknown[]; after: unknown[] } = { schema: 2, before: [], after: [] };
  for (const f of sides) {
    const sideDir = f.side === "before" ? "pre" : "post";
    const dir = join(lk, "issues", id, "img", sideDir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, f.file);
    await shot(path, "#101318", "#181c24", f.overflow);
    utimesSync(path, EVIDENCE_MTIME, EVIDENCE_MTIME);
    manifest[f.side].push({
      path: `img/${sideDir}/${f.file}`,
      route: f.route,
      formFactor: f.formFactor,
      scheme: "dark",
      state: "rest",
      at: AT,
    });
  }
  writeFileSync(join(lk, "issues", id, "frames.json"), JSON.stringify(manifest, null, 2) + "\n");
}

export async function buildFixture(root: string): Promise<{ project: string; home: string; checkout: string }> {
  rmSync(root, { recursive: true, force: true });
  const project = join(root, "project");
  const home = join(root, "home");
  const checkout = join(root, "checkout");
  const lk = join(project, ".lookout");
  mkdirSync(project, { recursive: true });
  // The capture workspace, exactly where the served ui will look for it:
  // keyed under the home that `serve` exports as LOOKOUT_HOME.
  const ev = join(home, "evidence", workspaceKey(project));
  for (const d of [home, lk, ev, join(ev, "web", "app", "root", "rest")]) {
    mkdirSync(d, { recursive: true });
  }

  writeFileSync(
    join(project, "lookout.config.ts"),
    'export default { targets: [{ name: "app", url: "http://127.0.0.1:5999", routes: ["/", "/settings"] }] };\n',
  );
  for (const [name, bg, bar] of [
    ["rest--desktop-dark.png", "#101318", "#181c24"],
    ["rest--desktop-light.png", "#ffffff", "#f2f3f6"],
  ] as const) {
    const path = join(ev, "web", "app", "root", name);
    await shot(path, bg, bar);
    utimesSync(path, EVIDENCE_MTIME, EVIDENCE_MTIME);
  }

  // A provenance sidecar for the dark shot only, its boxes hugging the exact
  // rectangles shot() draws, so the inspector's overlay can be judged by eye
  // in the captured views: one element with a full chain and file:line, one
  // with a component only, one with only a cssPath. The light shot stays
  // sidecar-less on purpose: the no-provenance path must stay on the board.
  const sidecar = {
    version: 1,
    shotId: "web/app/root/rest/desktop/dark",
    shotHash: "h1",
    origin: "document",
    devicePixelRatio: 1,
    viewport: { width: 1280, height: 900 },
    scroll: { x: 0, y: 0 },
    document: { width: 1280, height: 900 },
    originBox: { x: 0, y: 0, w: 1280, h: 900 },
    image: { width: 1280, height: 900 },
    truncated: false,
    resolved: {},
    elements: [
      { tag: "h1", id: "title", testid: null, role: null, classes: [], text: "Quarterly numbers",
        cssPath: "#title", landmark: false, box: { x: 40, y: 140, w: 520, h: 34 },
        components: ["Heading", "Page"], source: { file: "src/components/Heading.tsx", line: 12 } },
      { tag: "p", id: null, testid: "intro", role: null, classes: [], text: "The first paragraph",
        cssPath: "main > p:nth-of-type(1)", landmark: false, box: { x: 40, y: 200, w: 900, h: 18 },
        components: ["Intro"] },
      { tag: "p", id: null, testid: null, role: null, classes: [], text: null,
        cssPath: "main > p:nth-of-type(2)", landmark: false, box: { x: 40, y: 232, w: 820, h: 18 },
        components: [] },
      { tag: "div", id: "card", testid: null, role: null, classes: ["panel"], text: null,
        cssPath: "#card", landmark: false, box: { x: 40, y: 300, w: 300, h: 120 },
        components: [] },
    ],
  };
  const scPath = join(ev, "web", "app", "root", "rest--desktop-dark.png.provenance.json");
  writeFileSync(scPath, JSON.stringify(sidecar, null, 2));
  utimesSync(scPath, EVIDENCE_MTIME, EVIDENCE_MTIME);

  // The settled issue's own views, and the frames frozen either side of the fix
  // that closed it. The open issue has a pre-fix frame and no post-fix one,
  // which is what an issue nobody has fixed yet looks like; the intentional one
  // has neither, so the card falls back to the live strip.
  mkdirSync(join(ev, "web", "app", "settings"), { recursive: true });
  for (const name of ["rest--desktop-dark.png", "rest--phone-dark.png"]) {
    const path = join(ev, "web", "app", "settings", name);
    await shot(path, "#101318", "#181c24");
    utimesSync(path, EVIDENCE_MTIME, EVIDENCE_MTIME);
  }
  await freeze(lk, OPEN_ISSUE, [
    { side: "before", file: "web-app-root-rest--desktop-dark.png", route: "/", formFactor: "desktop", overflow: false },
  ]);
  await freeze(lk, SETTLED_ISSUE, [
    { side: "before", file: "web-app-settings-rest--desktop-dark.png", route: "/settings", formFactor: "desktop", overflow: true },
    { side: "before", file: "web-app-settings-rest--phone-dark.png", route: "/settings", formFactor: "phone", overflow: true },
    { side: "after", file: "web-app-settings-rest--desktop-dark.png", route: "/settings", formFactor: "desktop", overflow: false },
    { side: "after", file: "web-app-settings-rest--phone-dark.png", route: "/settings", formFactor: "phone", overflow: false },
  ]);

  writeFileSync(
    join(lk, "backlog.json"),
    JSON.stringify(
      {
        project: "fixture-app",
        generatedAt: AT,
        findings: {
          "app.root.rest.desktop.dark.contrast.body-text": finding({
            fingerprint: "app.root.rest.desktop.dark.contrast.body-text",
            category: "contrast",
            attribute: "body-text",
            status: "open",
            title: "Body text sits at 3.1:1 against the page background",
            problem: "Paragraph text is mid grey on near-black, below the 4.5:1 minimum.",
            expected: "Body copy at 4.5:1 or better.",
            observed: "Measured 3.1:1 across the article body.",
          }),
          "app.root.rest.desktop.dark.color-scheme.no-dark-theme": finding({
            fingerprint: "app.root.rest.desktop.dark.color-scheme.no-dark-theme",
            category: "color-scheme",
            attribute: "no-dark-theme",
            severity: "medium",
            status: "by-design",
            reason: "The marketing site is deliberately light-only; the product app is where the dark theme lives.",
            title: "Dark scheme does not apply anywhere on the page",
            problem: "The OS colour scheme is ignored.",
            expected: "A dark rendering.",
            observed: "The light rendering, unchanged.",
          }),
          "app.settings.rest.desktop.dark.layout-overflow.horizontal-scroll": finding({
            fingerprint: "app.settings.rest.desktop.dark.layout-overflow.horizontal-scroll",
            route: "/settings",
            category: "layout-overflow",
            attribute: "horizontal-scroll",
            status: "fixed",
            fixedIn: { commit: "9f2c41d7b6a8e05c3d1f", runId: "verify-fix-1", at: AT },
            title: "The settings table scrolls the page sideways",
            problem: "A 1500px table forces the document 220px wider than the viewport.",
            expected: "No horizontal scrollbar at any supported width.",
            observed: "document.scrollWidth 1500 against a 1280 viewport.",
            evidence: [
              { shotId: "web/app/settings/rest/desktop/dark", path: "web/app/settings/rest--desktop-dark.png", hash: "h3", at: AT },
            ],
          }),
          "app.settings.rest.phone.dark.layout-overflow.horizontal-scroll": finding({
            fingerprint: "app.settings.rest.phone.dark.layout-overflow.horizontal-scroll",
            route: "/settings",
            formFactor: "phone",
            category: "layout-overflow",
            attribute: "horizontal-scroll",
            status: "fixed",
            fixedIn: { commit: "9f2c41d7b6a8e05c3d1f", runId: "verify-fix-1", at: AT },
            title: "The settings table scrolls the page sideways",
            problem: "The same table, worse on a phone.",
            expected: "No horizontal scrollbar at any supported width.",
            observed: "document.scrollWidth 1500 against a 390 viewport.",
            evidence: [
              { shotId: "web/app/settings/rest/phone/dark", path: "web/app/settings/rest--phone-dark.png", hash: "h4", at: AT },
            ],
          }),
        },
        issues: {
          [OPEN_ISSUE]: { id: OPEN_ISSUE, key: "app--contrast--body-text", createdAt: AT, acceptance: [] },
          [INTENTIONAL_ISSUE]: {
            id: INTENTIONAL_ISSUE,
            key: "app--color-scheme--no-dark-theme",
            createdAt: AT,
            acceptance: [],
          },
          [SETTLED_ISSUE]: {
            id: SETTLED_ISSUE,
            key: "app--layout-overflow--horizontal-scroll",
            createdAt: AT,
            acceptance: [],
          },
        },
      },
      null,
      2,
    ),
  );

  // The folders the backlog projects. lookout writes one per issue on every
  // save, and the card links each issue's document, so a fixture without them
  // draws a board whose documents are all missing: the gate would capture that
  // absent state on every card and never once render the link.
  //
  // The intentional issue is left without one on purpose, the same way it is
  // the one issue with no frozen frames. An issue's document is a projection
  // of the backlog, and folders written by an older lookout can be missing; a
  // card whose folder is not on disk has to render without a link rather than
  // offering one that answers 404, and a fixture where every issue has a
  // document would never draw that.
  //
  // Both folders sit beside each other rather than one under `archive/`,
  // because that is where lookout would put them: the folder follows the
  // record's `archived` field, and the intentional issue here carries the older
  // adjudication instead, which never moved a folder.
  for (const [id, title] of [
    [OPEN_ISSUE, "Body text sits at 3.1:1 against the page background"],
    [SETTLED_ISSUE, "The settings table scrolls the page sideways"],
  ] as const) {
    const where = join(lk, "issues", id);
    mkdirSync(where, { recursive: true });
    writeFileSync(
      join(where, "Issue.md"),
      `# ${title}\n\n` +
        "```\n" +
        `issue:      ${id}\n` +
        `folder:     ${where}\n` +
        `repository: ${project}\n` +
        "```\n\n" +
        "This is a visual defect lookout found in the running application, filed\n" +
        "against the screenshots below. lookout did not send you here; somebody read\n" +
        "it and decided to. Nothing about how you fix it is prescribed.\n",
    );
  }

  // What lookout has done to its own instructions here.
  const skills = join(lk, "skills");
  mkdirSync(join(skills, "design-placement"), { recursive: true });
  mkdirSync(join(skills, "judge-core"), { recursive: true });
  writeFileSync(
    join(skills, "judge-core", "SKILL.md"),
    `---\nname: judge-core\ndescription: fixture-app's own rules for judge-core\nversion: 3\n---\n\n` +
      `## 2026-08-24: Stop filing the marketing site's light-only rendering\n\nThis project ships a light-only ` +
      `marketing site on purpose.\n`,
  );
  writeFileSync(
    join(skills, "design-placement", "PROPOSED.md"),
    "## 2026-08-29: prefer the kit's own spacing scale when placing a fix\n",
  );
  writeFileSync(
    join(skills, "history.jsonl"),
    [
      { at: "2026-08-21T09:14:02.000Z", skill: "judge-core", action: "no-change", summary: "Nothing in the signals contradicts the rubric as written." },
      {
        at: "2026-08-22T16:41:55.000Z",
        skill: "judge-core",
        action: "rolled-back",
        summary: "Treat any control under 40px as a tap-target defect.",
        evidence: ["issue 14"],
        violations: [
          { kind: "lost", shotId: "web/app/root/rest/desktop/dark", category: "contrast", why: "The confirmed contrast defect on these pixels was no longer filed." },
        ],
      },
      { at: "2026-08-24T11:07:30.000Z", skill: "judge-core", action: "applied", version: 3, summary: "Stop filing the marketing site's light-only rendering.", evidence: ["app.root.rest.desktop.dark.color-scheme.no-dark-theme"] },
      { at: "2026-08-29T18:22:09.000Z", skill: "design-placement", action: "proposed", summary: "Prefer the kit's own spacing scale when placing a fix.", evidence: ["issue 21"] },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );

  mkdirSync(join(lk, "regression", "shots"), { recursive: true });
  writeFileSync(
    join(lk, "regression", "manifest.json"),
    JSON.stringify(
      {
        note: "fixture",
        frozenAt: "2026-08-20T10:00:00.000Z",
        cases: [
          {
            shotId: "web/app/root/rest/desktop/dark",
            file: "web-app-root-rest--desktop-dark.png",
            target: "app",
            route: "/",
            routeName: "root",
            state: "rest",
            formFactor: "desktop",
            scheme: "dark",
            platform: "web",
            width: 1280,
            height: 900,
            mustFile: [{ category: "contrast", attribute: "body-text", why: "the verifier confirmed it" }],
            mustNotFile: [{ category: "color-scheme", attribute: "no-dark-theme", why: "ruled intentional by a person" }],
          },
        ],
      },
      null,
      2,
    ),
  );

  // What has gone wrong with lookout itself, machine-wide.
  writeFileSync(
    join(home, "incidents.jsonl"),
    [
      { at: "2026-08-25T12:00:00.000Z", kind: "judge-unparseable", verb: "check", message: "the judge reply at offset 2048 was not json" },
      { at: "2026-08-26T12:00:00.000Z", kind: "judge-unparseable", verb: "check", message: "the judge reply at offset 917 was not json" },
      { at: "2026-08-27T12:00:00.000Z", kind: "judge-unparseable", verb: "check", message: "the judge reply at offset 4400 was not json" },
      { at: "2026-08-28T12:00:00.000Z", kind: "operator-error", verb: "verify-fix", message: "no issue with id 42" },
      { at: "2026-08-29T12:00:00.000Z", kind: "self-heal-rollback", verb: "self-heal", message: "self-heal reverted: test failed" },
    ]
      .map((i) => JSON.stringify(i))
      .join("\n") + "\n",
  );

  const attempt = join(home, "self-heal", "2026-08-29T12-00-04-118Z");
  mkdirSync(attempt, { recursive: true });
  writeFileSync(join(attempt, "report.json"), JSON.stringify({ summary: "Retry the judge once more before giving up on the reply.", cause: "One retry is not enough when the model opens with prose." }));
  writeFileSync(join(attempt, "gates.txt"), "=== typecheck (pass): bun run typecheck\nok\n\n=== test (FAIL): bun test\n1 failing\n");
  writeFileSync(join(attempt, "attempt.diff"), "diff --git a/src/judge/engine.ts b/src/judge/engine.ts\n");

  // A checkout with heals that stuck, so the commits panel has something in it.
  mkdirSync(join(checkout, "src"), { recursive: true });
  // Fixed dates, because a commit's hash is made of them. Left to the clock,
  // every `fixture` build mints two new shas at a new time, the commits panel
  // draws different pixels, and the two learning views report a difference on
  // any comparison that rebuilt in between: noise that reads exactly like a
  // regression and trains whoever is looking to wave the panel through. Same
  // reason the evidence mtimes are backdated.
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "user.name=lookout", "-c", "user.email=lookout@example.com", ...args], {
      cwd: checkout,
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_DATE: AT, GIT_COMMITTER_DATE: AT },
    });
  git(["init", "-q"]);
  for (const [n, subject] of [
    ["1", "fix: retry the judge once more before giving up on the reply"],
    ["2", "fix: keep the contact sheet when a capture finds nothing"],
  ] as const) {
    writeFileSync(join(checkout, "src", "engine.ts"), `export const x = ${n};\n`);
    git(["add", "-A"]);
    git([
      "commit",
      "-q",
      "-m",
      `${subject}\n\nFound by \`lookout self-heal\` reading the incident log. Not pushed: that is a person's call.`,
    ]);
  }

  return { project, home, checkout };
}
