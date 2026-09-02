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
  return (await renderIssueDocument(r, cluster, backlog.issues![id])).markdown;
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
    expect(md).toContain("(run `r1`, finished 2026-08-28T14:02:11.000Z)");
    expect(md).toContain("The capture that filed this ran with: formFactors phone/desktop, schemes dark, axe route, settleMs 800.");
    expect(md).toContain("A `lookout capture` or `lookout check` of these");
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
