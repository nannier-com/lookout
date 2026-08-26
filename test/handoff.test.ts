// Handing one issue over.
//
// lookout does not dispatch work, so this only ever runs because a person
// clicked. What it produces has to stand on its own in a tool that knows
// nothing about lookout: absolute paths, the judge's actual prose, and the one
// instruction lookout is entitled to give, which is not to take your own word
// for whether the defect is gone.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHandoff, TOOLS, toolsAvailable } from "../src/report/handoff.js";
import type { BacklogFinding } from "../src/backlog/lib.js";
import type { ResolvedConfig } from "../src/types.js";

function project(): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), "lookout-handoff-"));
  mkdirSync(join(dir, ".lookout", "evidence", "fix"), { recursive: true });
  return {
    config: {} as ResolvedConfig["config"],
    configPath: join(dir, ".lookout/config.ts"),
    projectDir: dir,
    project: "app",
  } as ResolvedConfig;
}

function finding(over: Partial<BacklogFinding> = {}): BacklogFinding {
  const attribute = over.attribute ?? "header-icon-overlap";
  return {
    fingerprint: `app./dash.rest.phone.dark.layout-overflow.${attribute}`,
    target: "app",
    route: "/dash",
    state: "rest",
    platform: "web",
    formFactor: "phone",
    scheme: "dark",
    category: "layout-overflow",
    attribute,
    severity: "high",
    status: "open",
    reason: null,
    title: "Header icons collide with the activity row",
    problem: "A dark circular badge sits on top of the 'R' in 'Recent activity'.",
    expected: "The heading should be legible and unobstructed.",
    observed: "Two circular icons overlap the section header.",
    channel: "ai",
    confidence: "high",
    verified: true,
    evidence: [
      {
        shotId: "web/app/dash/rest/phone/dark",
        path: "web/app/dash/rest--phone-dark.png",
        hash: "h1",
        runId: "r1",
      },
    ],
    firstSeen: "r1",
    lastSeen: "r1",
    fixAttempts: 0,
    fixedIn: null,
    ...over,
  } as BacklogFinding;
}

function withBacklog(findings: BacklogFinding[]): ResolvedConfig {
  const r = project();
  writeFileSync(
    join(r.projectDir, ".lookout", "backlog.json"),
    JSON.stringify({
      note: "",
      project: "app",
      updatedAt: new Date(0).toISOString(),
      findings: Object.fromEntries(findings.map((f) => [f.fingerprint, f])),
    }),
  );
  return r;
}

describe("a handoff stands on its own", () => {
  test("every path in it is absolute, because somebody has to open them", async () => {
    const r = withBacklog([finding()]);
    const { markdown } = await renderHandoff(r, "app--layout-overflow--header-icon-overlap");
    const paths = markdown.match(/^\s*-?\s*(\/[^\s,]+\.png)/gm) ?? [];
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p.trim().replace(/^-\s*/, "").startsWith("/")).toBe(true);
    expect(markdown).toContain(join(r.projectDir, ".lookout/evidence/web/app/dash/rest--phone-dark.png"));
    expect(markdown).toContain(`repository: ${r.projectDir}`);
    // Relative paths would be read against whatever directory the tool opened in.
    expect(markdown).not.toContain("- web/app/dash");
  });

  test("it carries the judge's own words, not a summary of them", async () => {
    const r = withBacklog([finding()]);
    const { markdown } = await renderHandoff(r, "app--layout-overflow--header-icon-overlap");
    expect(markdown).toContain("A dark circular badge sits on top of the 'R' in 'Recent activity'.");
    expect(markdown).toContain("The heading should be legible and unobstructed.");
    expect(markdown).toContain("Two circular icons overlap the section header.");
    expect(markdown).toContain("adversarially verified");
  });

  test("it prescribes nothing except not trusting your own say-so", async () => {
    const r = withBacklog([finding()]);
    const { markdown } = await renderHandoff(r, "app--layout-overflow--header-icon-overlap");
    // The whole point of the re-scoping: lookout hands over a document, it does
    // not hand out orders. No subagents, no protocol, no dispatch.
    for (const word of ["subagent", "spawn", "dispatch", "brief", "protocol"]) {
      expect(markdown.toLowerCase()).not.toContain(word);
    }
    expect(markdown).toContain("Nothing about how you fix it is prescribed.");
    expect(markdown).toContain(
      "lookout verify-fix --cluster app--layout-overflow--header-icon-overlap",
    );
  });

  test("a grouped issue lists every defect in it", async () => {
    const r = withBacklog([
      finding(),
      // Same category and attribute, a different capture: one root cause seen
      // twice, which is exactly what an issue groups.
      finding({
        fingerprint: "app./dash.rest.phone.light.layout-overflow.header-icon-overlap",
        scheme: "light",
        title: "The same collision in the light scheme",
        problem: "The header repeats mid-page at 390px.",
        evidence: [
          {
            shotId: "web/app/dash/rest/phone/light",
            path: "web/app/dash/rest--phone-light.png",
            hash: "h2",
            runId: "r1",
          },
        ],
      }),
    ]);
    const { markdown } = await renderHandoff(r, "app--layout-overflow--header-icon-overlap");
    expect(markdown).toContain("Header icons collide with the activity row");
    // Both captures are named, so whoever opens this sees the whole defect.
    expect(markdown).toContain("rest--phone-dark.png");
    expect(markdown).toContain("rest--phone-light.png");
    expect(markdown).toContain("affects:    2 screenshot(s)");
  });

  test("an id nobody filed is an error, not an empty document", async () => {
    const r = withBacklog([finding()]);
    await expect(renderHandoff(r, "app--nope--nope")).rejects.toThrow("no issue with id");
  });
});

describe("the tools a handoff can be opened in", () => {
  test("each is reported with whether its binary is actually here", async () => {
    const available = await toolsAvailable();
    expect(available.map((t) => t.key).sort()).toEqual(Object.keys(TOOLS).sort());
    for (const t of available) {
      expect(typeof t.installed).toBe("boolean");
      expect(t.label.length).toBeGreaterThan(0);
    }
    // A missing tool must be reported, not hidden: the page offers the command
    // to run by hand instead of a button that quietly does nothing.
    expect(available.every((t) => t.bin.length > 0)).toBe(true);
  });
});
