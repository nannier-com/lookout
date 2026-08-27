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
import { launchHandoff, TOOLS, toolsAvailable } from "../src/report/handoff.js";
import { renderIssueDocument } from "../src/issues/document.js";
import { issuesOf } from "../src/issues/registry.js";
import { issueDir } from "../src/issues/paths.js";
import { loadBacklog } from "../src/verbs/backlog.js";
import { allRuleFiles, globalRuleFiles } from "../src/fix/rules.js";
import type { BacklogFinding } from "../src/backlog/lib.js";
import type { ResolvedConfig } from "../src/types.js";

function project(): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), "lookout-handoff-"));
  mkdirSync(join(dir, ".lookout", "evidence"), { recursive: true });
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

/**
 * The document for the one issue in this backlog. Ids are minted on load, so
 * the test asks which one it got rather than naming it: that is the whole point
 * of a random id.
 */
async function issueDoc(r: ResolvedConfig): Promise<{ markdown: string; id: string }> {
  const backlog = await loadBacklog(r);
  const cluster = issuesOf(backlog)[0];
  if (!cluster) throw new Error("no issue in this backlog");
  const { markdown } = await renderIssueDocument(r, cluster);
  return { markdown, id: cluster.id };
}

describe("a handoff stands on its own", () => {
  test("every path in it is absolute, because somebody has to open them", async () => {
    const r = withBacklog([finding()]);
    const { markdown } = await issueDoc(r);
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
    const { markdown } = await issueDoc(r);
    expect(markdown).toContain("A dark circular badge sits on top of the 'R' in 'Recent activity'.");
    expect(markdown).toContain("The heading should be legible and unobstructed.");
    expect(markdown).toContain("Two circular icons overlap the section header.");
    expect(markdown).toContain("adversarially verified");
  });

  test("it prescribes nothing except not trusting your own say-so", async () => {
    const r = withBacklog([finding()]);
    const { markdown, id } = await issueDoc(r);
    // The whole point of the re-scoping: lookout hands over a document, it does
    // not hand out orders. No subagents, no protocol, no dispatch.
    for (const word of ["subagent", "spawn", "dispatch", "brief", "protocol"]) {
      expect(markdown.toLowerCase()).not.toContain(word);
    }
    expect(markdown).toContain("Nothing about how you fix it is prescribed.");
    // However lookout is invoked here, the document has to end with a command
    // that actually runs: "lookout" is not on PATH in a source checkout, and a
    // handoff telling an agent to run a command that does not exist is worse
    // than one that says nothing.
    expect(markdown).toContain(`verify-fix --issue ${id} --commit <sha>`);
    const cmd = markdown
      .split("\n")
      .find((l: string) => l.includes("verify-fix --issue"))!;
    expect(cmd.startsWith("lookout ") || cmd.includes("cli.js")).toBe(true);
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
    const { markdown } = await issueDoc(r);
    expect(markdown).toContain("Header icons collide with the activity row");
    // Both captures are named, so whoever opens this sees the whole defect.
    expect(markdown).toContain("rest--phone-dark.png");
    expect(markdown).toContain("rest--phone-light.png");
    expect(markdown).toContain("affects:    2 screenshot(s)");
  });

  test("an id nobody filed is an error, not an empty document", async () => {
    const r = withBacklog([finding()]);
    await expect(launchHandoff(r, "404040", "codex")).rejects.toThrow("no issue with id");
  });

  test("the document names the folder that holds everything about the issue", async () => {
    const r = withBacklog([finding()]);
    const { markdown, id } = await issueDoc(r);
    expect(id).toMatch(/^[1-9][0-9]{5}$/);
    expect(markdown).toContain(`issue:      ${id}`);
    expect(markdown).toContain(`folder:     ${issueDir(r, id)}`);
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

  test("every tool carries a mark, and a project can supply its own", async () => {
    const builtIn = await toolsAvailable();
    for (const t of builtIn) expect(t.mark.startsWith("<svg")).toBe(true);

    const r = project();
    mkdirSync(join(r.projectDir, ".lookout", "logos"), { recursive: true });
    writeFileSync(
      join(r.projectDir, ".lookout", "logos", "codex.svg"),
      '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    );
    const supplied = await toolsAvailable(r);
    expect(supplied.find((t) => t.key === "codex")!.mark).toContain("<rect");
    // The one lookout was not given still uses its own drawing.
    expect(supplied.find((t) => t.key === "claude-code")!.mark).toBe(
      builtIn.find((t) => t.key === "claude-code")!.mark,
    );
  });

  test("a supplied file that is not a lone svg is ignored, not injected", async () => {
    const r = project();
    mkdirSync(join(r.projectDir, ".lookout", "logos"), { recursive: true });
    // This goes straight into the page, so anything carrying script is refused.
    writeFileSync(
      join(r.projectDir, ".lookout", "logos", "codex.svg"),
      '<svg><script>alert(1)</script></svg>',
    );
    const tools = await toolsAvailable(r);
    expect(tools.find((t) => t.key === "codex")!.mark).not.toContain("script");
  });
});

describe("a handoff names the rules that govern the work", () => {
  // A handoff is opened in an agent lookout did not configure. Claude Code
  // loads its own global file; nothing else does, and the whole point of the
  // toggle is that this may not be Claude Code. So they are named explicitly.
  test("global rules are found where each harness keeps them", async () => {
    const home = mkdtempSync(join(tmpdir(), "lookout-home-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# global\n");
    writeFileSync(join(home, ".codex", "AGENTS.md"), "# global\n");
    const found = await globalRuleFiles(home);
    expect(found).toContain(join(home, ".claude", "CLAUDE.md"));
    expect(found).toContain(join(home, ".codex", "AGENTS.md"));
  });

  test("nothing is invented when the operator has no global rules", async () => {
    const home = mkdtempSync(join(tmpdir(), "lookout-home-empty-"));
    expect(await globalRuleFiles(home)).toEqual([]);
  });

  test("the repository's own rules are found too, after the global ones", async () => {
    const r = withBacklog([finding()]);
    writeFileSync(join(r.projectDir, "CLAUDE.md"), "# project rules\n");
    const all = await allRuleFiles(r.projectDir);
    expect(all).toContain(join(r.projectDir, "CLAUDE.md"));
    // Global first: a standing rule is context for the project rule after it.
    const projectAt = all.indexOf(join(r.projectDir, "CLAUDE.md"));
    const globals = await globalRuleFiles();
    for (const g of globals) expect(all.indexOf(g)).toBeLessThan(projectAt);
  });

  test("the handoff lists them by absolute path, before the defect", async () => {
    const r = withBacklog([finding()]);
    writeFileSync(join(r.projectDir, "CLAUDE.md"), "# project rules\n");
    const { markdown } = await issueDoc(r);
    expect(markdown).toContain("## Read these first");
    expect(markdown).toContain(join(r.projectDir, "CLAUDE.md"));
    // Before the evidence, because an agent that edits first has already done
    // the damage by the time it reads them.
    expect(markdown.indexOf("## Read these first")).toBeLessThan(
      markdown.indexOf("## Look at these first"),
    );
    expect(markdown).toContain("They are not advisory.");
  });
});
