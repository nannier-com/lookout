// The issue document as a fixer's complete record.
//
// Everything a second attempt needs was already on disk and the document did
// not read it: the attempts in state.json, the verdict on each criterion, the
// blocked reason, what caused a regression. These pin that the document now
// says all of it, in the sentences the board uses, without ever issuing an
// order.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderIssueDocument } from "../src/issues/document.js";
import { issuesOf } from "../src/issues/registry.js";
import { issueDocPath } from "../src/issues/paths.js";
import { composeAcceptance } from "../src/issues/acceptance.js";
import { clusterScope, configuredRoutesOf } from "../src/fix/cluster.js";
import { saveState, type AttemptRecord } from "../src/fix/state.js";
import { evidenceDir } from "../src/config.js";
import { loadBacklog, saveBacklog } from "../src/verbs/backlog.js";
import type { Backlog, BacklogFinding } from "../src/backlog/lib.js";
import type { ResolvedConfig } from "../src/types.js";

function project(): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), "lookout-issuedoc-"));
  mkdirSync(join(dir, ".lookout"), { recursive: true });
  const r = {
    config: {} as ResolvedConfig["config"],
    configPath: join(dir, "lookout.config.ts"),
    projectDir: dir,
    project: "app",
  } as ResolvedConfig;
  mkdirSync(evidenceDir(r), { recursive: true });
  return r;
}

function finding(over: Partial<BacklogFinding> = {}): BacklogFinding {
  return {
    fingerprint: "app./dash.rest.phone.dark.layout-overflow.header-icon-overlap",
    target: "app",
    route: "/dash",
    state: "rest",
    platform: "web",
    formFactor: "phone",
    scheme: "dark",
    category: "layout-overflow",
    attribute: "header-icon-overlap",
    severity: "high",
    status: "open",
    reason: null,
    title: "Header icons collide with the activity row",
    problem: "A dark circular badge sits on top of the 'R' in 'Recent activity'.",
    expected: "The heading is legible and unobstructed.",
    observed: "Two circular icons overlap the section header.",
    channel: "ai",
    confidence: "high",
    verified: true,
    acceptance: ["The heading reads unobstructed at phone width", "The badge sits clear of the heading"],
    evidence: [{ shotId: "web/app/dash/rest/phone/dark", path: "web/app/dash/rest--phone-dark.png", hash: "h1", runId: "r1" }],
    firstSeen: "r1",
    lastSeen: "r1",
    fixAttempts: 0,
    fixedIn: null,
    ...over,
  } as BacklogFinding;
}

async function withBacklog(findings: BacklogFinding[]): Promise<{ r: ResolvedConfig; backlog: Backlog; id: string }> {
  const r = project();
  writeFileSync(
    join(r.projectDir, ".lookout", "backlog.json"),
    JSON.stringify({ project: "app", updatedAt: new Date(0).toISOString(), findings: Object.fromEntries(findings.map((f) => [f.fingerprint, f])) }),
  );
  const backlog = await loadBacklog(r);
  const id = issuesOf(backlog)[0]!.id;
  return { r, backlog, id };
}

async function render(r: ResolvedConfig, backlog: Backlog, id: string): Promise<string> {
  const cluster = issuesOf(backlog).find((c) => c.id === id)!;
  return (await renderIssueDocument(r, cluster, backlog.issues![id], { backlog })).markdown;
}

const attempt = (over: Partial<AttemptRecord>): AttemptRecord => ({
  n: 1,
  dispatchedAt: "2026-08-29T10:00:00.000Z",
  reported: { commit: "deadbee", note: "raised the contrast" },
  verdict: "still-open",
  judgeNote: "nothing changed: all 2 comparable screenshot(s) in this scope are byte-identical to the previous run",
  ...over,
});

describe("what has been tried", () => {
  test("every attempt is listed with what was reported and what lookout ruled", async () => {
    const { r, backlog, id } = await withBacklog([finding({ fixAttempts: 2 })]);
    await saveState(r, {
      id,
      attempts: [
        attempt({}),
        attempt({
          n: 2,
          dispatchedAt: "2026-08-30T10:00:00.000Z",
          reported: { commit: "cafef00d", note: "rebuilt the bundle" },
          judgeNote: "the badge still covers the heading",
          spawned: ["552140"],
        }),
      ],
    });
    const md = await render(r, backlog, id);
    expect(md).toContain("## What has been tried");
    expect(md).toContain("lookout has ruled on 2 attempts to fix this.");
    expect(md).toContain("### attempt 1, 2026-08-29T10:00:00.000Z");
    expect(md).toContain("- a fix was reported at deadbee: raised the contrast");
    expect(md).toContain("- lookout ruled it still-open: nothing changed: all 2 comparable");
    expect(md).toContain("### attempt 2, 2026-08-30T10:00:00.000Z");
    expect(md).toContain("- fixing this surfaced issue 552140");
    expect(md).toContain("- lookout ruled it still-open: the badge still covers the heading");
    expect(md).toContain("attempts:   2 of 2 spent (2 is the default cap; verify-fix --max-attempts raises it)");
    // Between the criteria and the pictures: the history before the plan.
    expect(md.indexOf("## Acceptance criteria")).toBeLessThan(md.indexOf("## What has been tried"));
    expect(md.indexOf("## What has been tried")).toBeLessThan(md.indexOf("## Look at these first"));
  });

  test("a judge that saw the same thing twice says so instead of repeating itself", async () => {
    const { r, backlog, id } = await withBacklog([finding({ fixAttempts: 2 })]);
    await saveState(r, {
      id,
      attempts: [attempt({}), attempt({ n: 2, dispatchedAt: "2026-08-30T10:00:00.000Z" })],
    });
    const md = await render(r, backlog, id);
    expect(md).toContain("- lookout ruled it still-open: unchanged from attempt 1");
    expect(md.split("nothing changed: all 2 comparable").length).toBe(2);
  });

  test("an issue nobody has tried has no section", async () => {
    const { r, backlog, id } = await withBacklog([finding()]);
    const md = await render(r, backlog, id);
    expect(md).not.toContain("## What has been tried");
    expect(md).not.toContain("attempts:");
  });

  test("a note is quoted as it was written: the rule about orders is about lookout's prose", async () => {
    const { r, backlog, id } = await withBacklog([finding({ fixAttempts: 1 })]);
    await saveState(r, { id, attempts: [attempt({ reported: { note: "see the brief in the PR" } })] });
    const md = await render(r, backlog, id);
    expect(md).toContain("- a fix was reported: see the brief in the PR");
  });

  test("a blocked issue says what reopens it and what the next ruling counts as", async () => {
    const { r, backlog, id } = await withBacklog([
      finding({ status: "blocked", fixAttempts: 2, reason: "2 fix attempt(s) did not clear this. The judge still sees: the badge" }),
    ]);
    await saveState(r, { id, attempts: [attempt({}), attempt({ n: 2, dispatchedAt: "2026-08-30T10:00:00.000Z" })] });
    const md = await render(r, backlog, id);
    expect(md).toContain("status:     blocked");
    expect(md).toContain("reason:     2 fix attempt(s) did not clear this.");
    expect(md).toContain("This issue is blocked: 2 attempts did not clear it");
    expect(md).toContain(`backlog set --issue ${id} --status open`);
    expect(md).toContain("The next ruling then counts as attempt 3.");
    expect(md).toContain("`--max-attempts 4`");
  });
});

describe("the acceptance criteria say what the last ruling saw", () => {
  test("not met is not the same box as not yet ruled, and every ruling carries its note", async () => {
    const { r, backlog, id } = await withBacklog([finding()]);
    const record = backlog.issues![id]!;
    const stamp = { ruledAt: "2026-08-30T10:00:00.000Z", runId: "verify-9" };
    record.acceptance = composeAcceptance([finding()]).map((c, i) => {
      if (c.source === "universal") return { ...c, ...stamp, verdict: "met", note: "1 of 2 screenshot(s) changed." };
      if (i === 0) return { ...c, ...stamp, verdict: "unmet", note: "The badge still sits over the R." };
      return c;
    });
    const md = await render(r, backlog, id);
    expect(md).toContain("- [!] The heading reads unobstructed at phone width");
    expect(md).toContain("  - not met: The badge still sits over the R.");
    expect(md).toContain("  - ruled 2026-08-30T10:00:00.000Z by run verify-9");
    expect(md).toContain("- [ ] The badge sits clear of the heading");
    expect(md).toContain("- [x] Every screenshot this issue was filed against was re-captured, and at least one changed.");
    expect(md).toContain("  - met: 1 of 2 screenshot(s) changed.");
    // The legend, so the marks need no key elsewhere.
    expect(md).toContain("`[!]` was not");
  });

  test("a criterion the verifier could not decide says why", async () => {
    const { r, backlog, id } = await withBacklog([finding()]);
    const record = backlog.issues![id]!;
    record.acceptance = composeAcceptance([finding()]).map((c, i) =>
      i === 0 ? { ...c, verdict: "not-verifiable", note: "the badge is off-screen at this width", ruledAt: "2026-08-30T10:00:00.000Z" } : c,
    );
    const md = await render(r, backlog, id);
    expect(md).toContain("- [-] The heading reads unobstructed at phone width");
    expect(md).toContain("  - could not be verified: the badge is off-screen at this width");
  });
});

describe("the header states what the record knows", () => {
  test("status, confidence, region, every route seen, and what caused a regression", async () => {
    const { r, backlog, id } = await withBacklog([
      finding({ confidence: "medium", region: "shell-nav", seenRoutes: ["/dash", "/settings"] }),
    ]);
    backlog.issues![id]!.causedBy = { issue: "418203", commit: "abc1234def", runId: "verify-3", at: "2026-08-28T09:00:00.000Z" };
    const md = await render(r, backlog, id);
    expect(md).toContain("status:     open");
    expect(md).toContain("confidence: medium");
    expect(md).toContain("region:     shell-nav");
    expect(md).toContain("seen on:    /dash, /settings");
    expect(md).toContain("caused by:  fixing issue 418203 at abc1234def");
    expect(md).toContain("run verify-3, 2026-08-28T09:00:00.000Z");
  });

  test("seen on is left out when it would only repeat the routes", async () => {
    const { r, backlog, id } = await withBacklog([finding({ seenRoutes: ["/dash"] })]);
    const md = await render(r, backlog, id);
    expect(md).not.toContain("seen on:");
    expect(md).not.toContain("region:");
    expect(md).not.toContain("caused by:");
  });
});

describe("the richer document still hands over facts, not orders", () => {
  test("none of the words lookout renounced appear in its own prose", async () => {
    const { r, backlog, id } = await withBacklog([
      finding({ status: "blocked", fixAttempts: 2, reason: "2 fix attempt(s) did not clear this.", region: "shell-nav", seenRoutes: ["/dash", "/settings"] }),
    ]);
    backlog.issues![id]!.causedBy = { issue: "418203", commit: null, runId: "verify-3", at: "2026-08-28T09:00:00.000Z" };
    await saveState(r, {
      id,
      attempts: [attempt({ spawned: ["552140"] }), attempt({ n: 2, dispatchedAt: "2026-08-30T10:00:00.000Z", judgeNote: "still there" })],
    });
    const md = (await render(r, backlog, id)).toLowerCase();
    for (const word of ["subagent", "spawn", "dispatch", "brief", "protocol"]) {
      expect(md).not.toContain(word);
    }
  });

  test("every heading is preceded by a blank line", async () => {
    const { r, backlog, id } = await withBacklog([finding({ fixAttempts: 1 })]);
    await saveState(r, { id, attempts: [attempt({})] });
    const md = await render(r, backlog, id);
    const lines = md.split("\n");
    lines.forEach((line, i) => {
      if (line.startsWith("## ") && i > 0) expect({ heading: line, before: lines[i - 1] }).toEqual({ heading: line, before: "" });
    });
  });
});

describe("the document regenerated by a ruling carries that ruling", () => {
  test("the attempt is written before the save that rewrites the document", async () => {
    const { r, backlog, id } = await withBacklog([finding({ fixAttempts: 1 })]);
    // The order verify-fix now uses: state first, then the save that projects
    // the folders. The other way round, this file could never say "attempt 1".
    await saveState(r, { id, attempts: [attempt({})] });
    await saveBacklog(r, backlog);
    const md = readFileSync(issueDocPath(r, id), "utf8");
    expect(md).toContain("### attempt 1, 2026-08-29T10:00:00.000Z");
    expect(md).toContain("- a fix was reported at deadbee: raised the contrast");
  });
});

describe("the scope of verification is stated before anyone asks for a ruling", () => {
  function withRoutes(r: ResolvedConfig, routes: (string | { path: string })[], startHint?: string): void {
    r.config = {
      targets: [{ name: "app", url: "http://127.0.0.1:5999", routes, ...(startHint ? { startHint } : {}) }],
    } as ResolvedConfig["config"];
  }

  test("a shell defect names every route lookout will photograph, and which the config added", async () => {
    const { r, backlog, id } = await withBacklog([finding({ region: "shell-nav", seenRoutes: ["/dash"] })]);
    withRoutes(r, ["/dash", { path: "/settings" }, "/about"], "bun run dev");
    const md = await render(r, backlog, id);
    expect(md).toContain("## Scope of verification");
    expect(md).toContain("`verify-fix` photographs target `app` at http://127.0.0.1:5999 on `/dash`, `/settings`.");
    expect(md).toContain("`/settings` is not where this was filed: a shell defect is ruled on at least 2 routes");
    expect(md).toContain("re-judged by `judge-geometry`, the panel that filed this");
    expect(md).toContain("The config says the application is started with `bun run dev`.");
    // The same derivation the verb uses, so the two cannot disagree.
    const cluster = issuesOf(backlog).find((c) => c.id === id)!;
    expect(clusterScope(cluster, configuredRoutesOf(r.config, "app")).routes).toEqual(["/dash", "/settings"]);
  });

  test("a content defect is photographed where it was filed, and the filing run's flags are named", async () => {
    const { r, backlog, id } = await withBacklog([finding()]);
    withRoutes(r, ["/dash", "/settings"]);
    writeFileSync(
      join(evidenceDir(r), "capture-report.json"),
      JSON.stringify({
        version: 1, project: "app", createdAt: "t", updatedAt: "t",
        runs: [{ id: "r1", kind: "web", startedAt: "2026-08-28T14:00:00.000Z", finishedAt: "2026-08-28T14:02:11.000Z",
          flags: { formFactors: ["phone", "desktop"], schemes: ["dark"], axe: "route", settleMs: 800 }, failures: [], skips: [] }],
        shots: [],
      }),
    );
    const md = await render(r, backlog, id);
    expect(md).toContain("photographs target `app` at http://127.0.0.1:5999 on `/dash`.");
    expect(md).not.toContain("shell defect");
    expect(md).toContain("lookout's last capture of these routes (run `r1`, finished 2026-08-28T14:02:11.000Z)");
    expect(md).toContain("The capture that filed this ran with: formFactors phone/desktop, schemes dark, axe route, settleMs 800.");
    expect(md).toContain("between the edit and the ruling does not move that baseline");
    expect(md).toContain("`--no-capture` rules on the last capture");
  });

  test("the verify block says what an attempt costs and what every exit code means", async () => {
    const { r, backlog, id } = await withBacklog([finding({ fixAttempts: 1 })]);
    const md = await render(r, backlog, id);
    expect(md).toContain(`verify-fix --issue ${id} --commit <sha> --note "<root cause>"`);
    expect(md).toContain("`--commit` may be left out: lookout reads the repository's HEAD.");
    expect(md).toContain("A ruling that does not pass spends an attempt: 1 of 2 is spent,");
    expect(md).toContain("`--max-attempts <n>` raises the cap for one ruling.");
    expect(md).toContain("2 means lookout could");
    expect(md).toContain("no attempt was spent, 3 means it is out of attempts.");
  });

  test("a source finding has no capture scope: nothing is photographed", async () => {
    const { r, backlog, id } = await withBacklog([
      finding({ channel: "code", source: { path: "src/Button.tsx", line: 12, symbol: "Button", foundBy: "scan" } } as Partial<BacklogFinding>),
    ]);
    const md = await render(r, backlog, id);
    expect(md).not.toContain("## Scope of verification");
    expect(md).toContain("Nothing is re-photographed");
  });

  test("configured routes are read the same way whether written as strings or objects", () => {
    const config = { targets: [{ name: "app", routes: ["/", { path: "/settings" }] }, { name: "admin", routes: ["/x"] }] };
    expect(configuredRoutesOf(config, "app")).toEqual(["/", "/settings"]);
    expect(configuredRoutesOf(config, "admin")).toEqual(["/x"]);
    expect(configuredRoutesOf(config, "none")).toEqual([]);
    expect(configuredRoutesOf({}, "app")).toEqual([]);
  });
});

describe("the other issues on the same screenshot are named", () => {
  const sibling = (over: Partial<BacklogFinding>): BacklogFinding =>
    finding({
      fingerprint: "app./dash.rest.phone.dark.render-failure.page-error",
      category: "render-failure",
      attribute: "page-error",
      channel: "deterministic",
      title: "TypeError: Cannot read properties of undefined (reading 'items')",
      acceptance: [],
      ...over,
    });

  test("an open finding sharing a shot is listed with its own issue id", async () => {
    const { r, backlog, id } = await withBacklog([finding(), sibling({})]);
    const md = await render(r, backlog, id);
    const other = issuesOf(backlog).find((c) => c.id !== id)!.id;
    expect(md).toContain("## Also on this screenshot");
    expect(md).toContain(`- issue ${other} (high, render-failure/page-error): TypeError: Cannot read properties of undefined (reading 'items')`);
    expect(md).toContain("None of them is");
    // And the sibling's own document points back.
    const back = await render(r, backlog, other);
    expect(back).toContain(`- issue ${id} (high, layout-overflow/header-icon-overlap): Header icons collide with the activity row`);
  });

  test("a finding on another screenshot, or one already settled, is not a sibling", async () => {
    const { r, backlog, id } = await withBacklog([
      finding(),
      sibling({
        fingerprint: "app./settings.rest.phone.dark.render-failure.page-error",
        route: "/settings",
        evidence: [{ shotId: "web/app/settings/rest/phone/dark", path: "web/app/settings/rest--phone-dark.png", hash: "h2", runId: "r1" }],
      }),
      sibling({
        fingerprint: "app./dash.rest.phone.dark.render-failure.console-error",
        attribute: "console-error",
        status: "fixed",
        fixedIn: { commit: "abc", runId: "r2" },
      }),
    ]);
    const md = await render(r, backlog, id);
    expect(md).not.toContain("## Also on this screenshot");
  });

  test("without the backlog in hand the section is simply absent", async () => {
    const { r, backlog, id } = await withBacklog([finding(), sibling({})]);
    const cluster = issuesOf(backlog).find((c) => c.id === id)!;
    const { markdown } = await renderIssueDocument(r, cluster, backlog.issues![id]);
    expect(markdown).not.toContain("## Also on this screenshot");
  });
});

describe("how to see it", () => {
  const sidecar = (over: Record<string, unknown> = {}) => ({
    version: 1,
    note: "fixture",
    shotId: "web/app/dash/rest/phone/dark",
    runId: "r1",
    capturedAt: "2026-08-28T14:02:11.000Z",
    shotHash: "h1",
    origin: "document",
    image: { width: 780, height: 1688 },
    devicePixelRatio: 2,
    viewport: { width: 390, height: 844 },
    scroll: { x: 0, y: 0 },
    document: { width: 390, height: 844 },
    originBox: { x: 0, y: 0, w: 390, h: 844 },
    elements: [
      { tag: "header", id: null, testid: null, role: "banner", classes: ["top"], text: "Recent activity",
        cssPath: "body > header", landmark: true, box: { x: 0, y: 0, w: 390, h: 64 },
        components: ["Header", "AppShell"], source: { file: "src/Header.tsx", line: 12 } },
    ],
    resolved: {},
    truncated: false,
    ...over,
  });

  function withConfig(r: ResolvedConfig): void {
    r.config = {
      targets: [{ name: "app", url: "http://127.0.0.1:5999", routes: [{ path: "/dash", element: "main", design: "design/dash.png" }] }],
      scheme: { mode: "url-param", param: "theme" },
      viewports: { phone: { width: 400, height: 800 } },
    } as ResolvedConfig["config"];
  }

  test("each view names its url, viewport, scheme mechanism, element and design, marked as derived", async () => {
    const { r, backlog, id } = await withBacklog([finding()]);
    withConfig(r);
    const md = await render(r, backlog, id);
    expect(md).toContain("## How to see it");
    expect(md).toContain("### /dash, phone, dark scheme, state rest");
    expect(md).toContain("- url: http://127.0.0.1:5999/dash?theme=dark (per the current config)");
    expect(md).toContain("- viewport: 400×800 css px at 2× (the screenshot is 800 px wide) (per the current config)");
    expect(md).toContain("- scheme via: the `theme` url parameter, already in the url above");
    expect(md).toContain("- element: only `main` was photographed, not the whole page (per the current config)");
    expect(md).toContain(`- design hand-off: ${join(r.projectDir, "design", "dash.png")}; the judge compared this view to it one to one`);
    expect(md).toContain(`- workspace screenshot: ${join(evidenceDir(r), "web/app/dash/rest--phone-dark.png")}; overwritten by every capture`);
  });

  test("a state other than rest says what it is and what was clicked to reach it", async () => {
    const { r, backlog, id } = await withBacklog([finding({ state: "menu-open" })]);
    withConfig(r);
    writeFileSync(
      join(r.projectDir, ".lookout", "navigation.json"),
      JSON.stringify({
        version: 1,
        routes: {
          "app|/dash": {
            signature: "s", plannedAt: "t", skillVersion: 2, checks: [], skipped: [], suggestions: [],
            states: [{ name: "menu-open", affordance: { selector: "header button", role: "button", name: "Menu", href: null }, outcome: "overlay", risk: "safe", why: "the navigation drawer open" }],
          },
        },
      }),
    );
    const md = await render(r, backlog, id);
    expect(md).toContain("### /dash, phone, dark scheme, state menu-open");
    expect(md).toContain('- state `menu-open`: the navigation drawer open; reached by clicking button "Menu" (`header button`), expecting overlay');
  });

  test("a state with no plan behind it is still named as a recipe", async () => {
    const { r, backlog, id } = await withBacklog([finding({ state: "signed-in" })]);
    withConfig(r);
    const md = await render(r, backlog, id);
    expect(md).toContain("- state `signed-in`: a recipe named in the config; lookout drives the page into it before photographing");
  });

  test("the sidecar is named beside the view, and names the elements under where it renders", async () => {
    const { r, backlog, id } = await withBacklog([finding()]);
    withConfig(r);
    const rel = "web/app/dash/rest--phone-dark.png";
    mkdirSync(join(evidenceDir(r), "web", "app", "dash"), { recursive: true });
    writeFileSync(join(evidenceDir(r), `${rel}.provenance.json`), JSON.stringify(sidecar()));
    writeFileSync(
      join(evidenceDir(r), "capture-report.json"),
      JSON.stringify({
        version: 1, project: "app", createdAt: "t", updatedAt: "t",
        runs: [{ id: "r1", kind: "web", startedAt: "t", finishedAt: "t", flags: {}, failures: [], skips: [] }],
        shots: [{ id: "web/app/dash/rest/phone/dark", target: "app", route: "/dash", routeName: "dash", state: "rest", platform: "web",
          formFactor: "phone", scheme: "dark", path: rel, hash: "h1", bytes: 1, width: 780, height: 1688, animated: false,
          design: "/abs/design.png", designHash: "d1", provenance: `${rel}.provenance.json`,
          capturedAt: "2026-08-28T14:02:11.000Z", runId: "r1", deterministicFindings: [] }],
      }),
    );
    const md = await render(r, backlog, id);
    expect(md).toContain(`- provenance sidecar: ${join(evidenceDir(r), `${rel}.provenance.json`)} (1 elements, each with its css path`);
    // Recorded wins over derived: the report's design, with its hash.
    expect(md).toContain("- design hand-off: /abs/design.png (sha256 d1)");
    expect(md).toContain("- captured 2026-08-28T14:02:11.000Z by run r1");
    // A judged finding carries no renderedBy, and used to get no section at all.
    expect(md).toContain("## Where it renders");
    expect(md).toContain("- Header < AppShell  src/Header.tsx:12  (header \"Recent activity\")");
  });

  test("a re-captured sidecar says positions may have moved", async () => {
    const { r, backlog, id } = await withBacklog([finding()]);
    withConfig(r);
    const rel = "web/app/dash/rest--phone-dark.png";
    mkdirSync(join(evidenceDir(r), "web", "app", "dash"), { recursive: true });
    writeFileSync(join(evidenceDir(r), `${rel}.provenance.json`), JSON.stringify(sidecar({ shotHash: "h9" })));
    const md = await render(r, backlog, id);
    expect(md).toContain("re-captured since this evidence, so positions may have moved");
  });
});

describe("artifacts", () => {
  test("the config is always named; the rest only when on disk", async () => {
    const { r, backlog, id } = await withBacklog([finding()]);
    const before = await render(r, backlog, id);
    expect(before).toContain("## Artifacts");
    expect(before).toContain(`- config: ${r.configPath}`);
    expect(before).toContain(`- backlog: ${join(r.projectDir, ".lookout", "backlog.json")}`);
    expect(before).not.toContain("- capture report:");
    writeFileSync(join(evidenceDir(r), "capture-report.json"), JSON.stringify({ version: 1, project: "app", createdAt: "t", updatedAt: "t", runs: [], shots: [] }));
    writeFileSync(join(evidenceDir(r), `verify-${id}.png`), "");
    const after = await render(r, backlog, id);
    expect(after).toContain(`- capture report: ${join(evidenceDir(r), "capture-report.json")}`);
    expect(after).toContain(`- contact sheet of the last verify-fix of this issue: ${join(evidenceDir(r), `verify-${id}.png`)}`);
  });
});

describe("what the ruling saw is written under the attempt", () => {
  test("screenshot counts, the run, the flags, still-open findings, failed criteria, and the repository", async () => {
    const { r, backlog, id } = await withBacklog([finding({ fixAttempts: 2 })]);
    const sheet = join(evidenceDir(r), `verify-${id}.png`);
    writeFileSync(sheet, "");
    await saveState(r, {
      id,
      attempts: [
        attempt({}),
        attempt({
          n: 2,
          dispatchedAt: "2026-08-30T10:00:00.000Z",
          reported: { commit: "cafef00d", note: "rebuilt the bundle" },
          judgeNote: "the badge still covers the heading",
          runId: "verify-9",
          totalShots: 6,
          changedShots: 1,
          baselineShots: 6,
          flags: { viewports: "phone", "no-cache": true },
          stillOpen: [{ title: "Header icons collide with the activity row", shotId: "web/app/dash/rest/phone/dark", observed: "the badge still covers the heading" }],
          unclosable: ["/settings"],
          criteria: [{ id: "c1", text: "The heading reads unobstructed at phone width", verdict: "unmet", note: "The badge still sits over the R." }],
          contactSheet: sheet,
          observed: { head: "cafef00d", dirty: true, dirtyFiles: ["src/Header.tsx"], filesChanged: ["src/Header.tsx", "src/header.css"] },
        }),
      ],
    });
    const md = await render(r, backlog, id);
    expect(md).toContain("- in the repository: HEAD cafef00d; 1 uncommitted file(s): src/Header.tsx; changed since attempt 1: src/Header.tsx, src/header.css");
    expect(md).toContain("- re-captured: 1 of 6 comparable screenshot(s) changed (6 in scope), run verify-9; flags: --viewports phone --no-cache");
    expect(md).toContain("- pixels unchanged since filing on /settings, so nothing there could close");
    expect(md).toContain("- still filed after this attempt: Header icons collide with the activity row (web/app/dash/rest/phone/dark): the badge still covers the heading");
    expect(md).toContain("- criterion not met: The heading reads unobstructed at phone width: The badge still sits over the R.");
    expect(md).toContain(`- contact sheet of that capture: ${sheet}`);
    // The order a reader needs: what was reported, what lookout observed, what it saw, then the verdict.
    const i = (s: string) => md.indexOf(s);
    expect(i("a fix was reported at cafef00d")).toBeLessThan(i("- in the repository: HEAD cafef00d"));
    expect(i("- in the repository: HEAD cafef00d")).toBeLessThan(i("- re-captured: 1 of 6"));
    expect(i("- criterion not met:")).toBeLessThan(i("- lookout ruled it still-open: the badge still covers the heading"));
  });

  test("a clean tree and no change since the previous commit are said as such", async () => {
    const { r, backlog, id } = await withBacklog([finding({ fixAttempts: 2 })]);
    await saveState(r, {
      id,
      attempts: [attempt({}), attempt({ n: 2, observed: { head: "deadbee", dirty: false, filesChanged: [] } })],
    });
    const md = await render(r, backlog, id);
    expect(md).toContain("- in the repository: HEAD deadbee; working tree clean; no files changed since attempt 1");
  });

  test("a criterion says which shots decided it and what the verifier suggested", async () => {
    const { r, backlog, id } = await withBacklog([finding()]);
    const record = backlog.issues![id]!;
    record.acceptance = composeAcceptance([finding()]).map((c, i) =>
      i === 0
        ? { ...c, verdict: "unmet", note: "The badge still sits over the R.", evidence: ["web/app/dash/rest/phone/dark"], suggestion: "move the badge below the heading" }
        : c,
    );
    const md = await render(r, backlog, id);
    expect(md).toContain("  - decided on: web/app/dash/rest/phone/dark");
    expect(md).toContain("  - the verifier suggested: move the badge below the heading");
  });
});

describe("what a ruling is measured against", () => {
  test("after a ruling, the previous ruling's capture; the attempt says what it compared against", async () => {
    const { r, backlog, id } = await withBacklog([finding({ fixAttempts: 1 })]);
    withRoutesFor(r);
    const state = { id, attempts: [attempt({ baseline: { kind: "frozen" as const, at: "2026-08-28T14:02:11.000Z" }, totalShots: 2, changedShots: 1, baselineShots: 2 })],
      baseline: { runId: "web-verify-1", capturedAt: "2026-08-29T10:00:00.000Z", hashes: { "web/app/dash/rest/phone/dark": "h2" } } };
    await saveState(r, state);
    const md = await render(r, backlog, id);
    expect(md).toContain("compared to\nthe capture of the previous ruling (run `web-verify-1`, 2026-08-29T10:00:00.000Z), and a fix");
    expect(md).toContain("compared against the frames frozen when this was filed (2026-08-28T14:02:11.000Z)");
  });

  test("before any ruling, the frames frozen when the issue was filed", async () => {
    const r0 = project();
    // A screenshot on disk, so the save that files the issue freezes a frame of it.
    mkdirSync(join(evidenceDir(r0), "web", "app", "dash"), { recursive: true });
    writeFileSync(join(evidenceDir(r0), "web/app/dash/rest--phone-dark.png"), "png-bytes");
    writeFileSync(
      join(r0.projectDir, ".lookout", "backlog.json"),
      JSON.stringify({ project: "app", updatedAt: new Date(0).toISOString(), findings: { [finding().fingerprint]: finding() } }),
    );
    const backlog = await loadBacklog(r0);
    const id = issuesOf(backlog)[0]!.id;
    withRoutesFor(r0);
    const md = await render(r0, backlog, id);
    expect(md).toContain("compared to\nthe frames frozen when this issue was filed (");
  });

  function withRoutesFor(r: ResolvedConfig): void {
    r.config = { targets: [{ name: "app", url: "http://127.0.0.1:5999", routes: ["/dash"] }] } as ResolvedConfig["config"];
  }
});

describe("what the check recorded, and what the verifier said", () => {
  test("a deterministic defect lists the check's record key by key", async () => {
    const { r, backlog, id } = await withBacklog([
      finding({
        fingerprint: "app./dash.rest.phone.dark.a11y.axe-heading-order",
        category: "a11y",
        attribute: "axe-heading-order",
        channel: "deterministic",
        title: "heading-order: Heading levels should only increase by one",
        problem: "Plain half.\n\nDetail half.",
        acceptance: [],
        check: { type: "axe-violation", meta: { ruleId: "heading-order", impact: "moderate", nodeCount: 2, targets: ["#root > div > h4", "main h5"], helpUrl: "https://dequeuniversity.com/rules/axe/4.10/heading-order", failureSummary: ["Fix any of the following: Heading order invalid"] } },
      } as Partial<BacklogFinding>),
    ]);
    const md = await render(r, backlog, id);
    expect(md).toContain("**What the check recorded**");
    expect(md).toContain("- type: axe-violation");
    expect(md).toContain("- ruleId: heading-order");
    expect(md).toContain("- nodeCount: 2");
    expect(md).toContain("- targets: #root > div > h4, main h5");
    expect(md).toContain("- failureSummary: Fix any of the following: Heading order invalid");
    expect(md).toContain("- helpUrl: https://dequeuniversity.com/rules/axe/4.10/heading-order");
    expect(md.indexOf("Detail half.")).toBeLessThan(md.indexOf("**What the check recorded**"));
  });

  test("a judged defect carries the verifier's own account", async () => {
    const { r, backlog, id } = await withBacklog([finding({ verifierNote: "The badge covers the R; confirmed from the phone shot." } as Partial<BacklogFinding>)]);
    const md = await render(r, backlog, id);
    expect(md).toContain("- **the verifier said** The badge covers the R; confirmed from the phone shot.");
    expect(md).not.toContain("**What the check recorded**");
  });
});

describe("what capture recorded about the view wins over the config", () => {
  test("url, viewport, scale, scheme, element and the state's affordance come from the finding when the workspace is gone", async () => {
    const { r, backlog, id } = await withBacklog([
      finding({
        state: "menu-open",
        view: {
          url: "http://127.0.0.1:5999/dash?theme=dark",
          finalUrl: "http://127.0.0.1:5999/dash?theme=dark#top",
          viewport: { width: 412, height: 915 },
          dpr: 3,
          schemeMechanism: "url-param",
          element: "main",
          stateDescription: "the navigation drawer open",
          stateAffordance: { selector: "header button", role: "button", name: "Menu", href: null, outcome: "overlay" },
          design: "/abs/design.png",
          designHash: "d9",
        },
      } as Partial<BacklogFinding>),
    ]);
    // A config that says something else, to prove it is not consulted.
    r.config = { targets: [{ name: "app", url: "http://elsewhere:1", routes: ["/dash"] }], viewports: { phone: { width: 100, height: 100 } } } as ResolvedConfig["config"];
    const md = await render(r, backlog, id);
    expect(md).toContain("- url: http://127.0.0.1:5999/dash?theme=dark, which landed on http://127.0.0.1:5999/dash?theme=dark#top");
    expect(md).toContain("- viewport: 412×915 css px at 3× (the screenshot is 1236 px wide)");
    expect(md).not.toContain("412×915 css px at 3× (the screenshot is 1236 px wide) (per the current config)");
    expect(md).toContain("- scheme via: the url parameter, already in the url above");
    expect(md).toContain("- element: only `main` was photographed, not the whole page");
    expect(md).toContain('- state `menu-open`: the navigation drawer open; reached by clicking button "Menu" (`header button`), expecting overlay');
    expect(md).toContain("- design hand-off: /abs/design.png (sha256 d9)");
  });
});
