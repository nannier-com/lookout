// What the screen navigator is told: every slot filled, the map's own words
// for how the screen is reached, the recording as steps a person could
// follow, and the tool vocabulary of whichever AI is reading.
import { describe, expect, test } from "bun:test";
import { actionLine, howToReachOf, navigatePrompt } from "../src/mcp/prompt.js";
import { loadSkill } from "../src/skills/load.js";
import type { MapNode } from "../src/map/store.js";
import type { NavAction } from "../src/mcp/actions.js";
import { tmpProject } from "./tmp-project.js";

function node(partial: Partial<MapNode> & Pick<MapNode, "id" | "kind">): MapNode {
  return { title: partial.id, open: null, risk: "safe", platforms: ["web"], source: { path: "/repo/src/App.tsx" }, why: "", children: [], ...partial };
}

const menu = node({
  id: "menu-open",
  kind: "state",
  title: "Main menu",
  open: { affordance: { role: "button", name: "Menu" }, outcome: "overlay" },
  why: "the drawer the rest screenshot never shows",
});

describe("the navigate-screen skill", () => {
  test("loads with its contract, carries the two-audience rule, and names no reader", async () => {
    const skill = await loadSkill(null, "navigate-screen");
    expect(skill.output).toBe("navigate-screen-v1");
    expect(skill.text).toContain("screen navigator");
    expect(skill.text).toContain("## Who reads what you write");
    expect(skill.text).toContain("{{howToCall}}");
  });

  test("renders with every slot filled, in the reader's own tool vocabulary", async () => {
    const r = tmpProject("lookout-nav-prompt-");
    const recorded: NavAction[] = [
      { tool: "open", args: { path: "/" }, outcome: {}, at: "t" },
      { tool: "click", args: { affordance: { selector: "#m", role: "button", name: "Menu", href: null } }, outcome: { navigated: false }, at: "t" },
    ];
    const { prompt, skillVersion } = await navigatePrompt(r, {
      target: "app",
      platform: "web",
      screenId: "app|/|menu-open",
      node: menu,
      chain: [node({ id: "/", kind: "route", title: "Home" })],
      recorded,
      maxActions: 40,
    });
    expect(skillVersion).toBeGreaterThan(0);
    expect(prompt).not.toMatch(/\{\{[A-Za-z0-9_:.-]+\}\}/);
    expect(prompt).toContain("Screen `app|/|menu-open`: Main menu");
    expect(prompt).toContain('activate the button "Menu"; the map expects that something opens above the page. The map\'s note: the drawer');
    expect(prompt).toContain("Home > this screen");
    expect(prompt).toContain('1. click the button "Menu"');
    expect(prompt).toContain("mcp__lookout__");
    expect(prompt).toContain("at most 40 actions");
  });

  test("a screen nobody reached before says so, and the Codex vocabulary is used when Codex reads", async () => {
    const r = tmpProject("lookout-nav-prompt2-");
    const { prompt } = await navigatePrompt(r, { target: "app", platform: "ios", screenId: "app|/|rest", node: node({ id: "/", kind: "route", title: "Home" }), chain: [], maxActions: 10, ai: "codex" });
    expect(prompt).toContain("Nobody has reached this screen before");
    expect(prompt).toContain("a top-level screen of the target");
    expect(prompt).toContain('the tools of the "lookout" server');
    expect(prompt).not.toContain("mcp__lookout__");
  });
});

describe("the words for a node and an action", () => {
  test("howToReachOf covers a route by url, a control, a deep link and a tap", () => {
    expect(howToReachOf(node({ id: "/", kind: "route" }))).toContain("by opening the route directly");
    expect(howToReachOf(node({ id: "/p", kind: "route", open: { affordance: { role: "link", name: "Pricing", href: "/p" }, outcome: "navigation" } }))).toBe(
      'follow the link "Pricing" (/p); the map expects that the app navigates.',
    );
    expect(howToReachOf(node({ id: "/d", kind: "route", open: { outcome: "navigation", deepLink: "/d" } }))).toBe("by deep link to /d.");
    expect(howToReachOf(node({ id: "sheet", kind: "state", open: { outcome: "overlay", tap: { label: "More" } } }))).toContain('tap "More"');
  });

  test("actionLine reads like a step", () => {
    expect(actionLine({ tool: "type", args: { affordance: { selector: "", role: "textbox", name: "Query", href: null }, text: "shoes" }, outcome: {}, at: "t" })).toBe('type the textbox "Query" with "shoes"');
    expect(actionLine({ tool: "tap", args: { x: 10, y: 20 }, outcome: {}, at: "t" })).toBe("tap (10, 20)");
    expect(actionLine({ tool: "tap", args: { x: 10, y: 20, label: "More" }, outcome: {}, at: "t" })).toBe('tap "More"');
    expect(actionLine({ tool: "swipe", args: { from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }, outcome: {}, at: "t" })).toBe("swipe from (1, 2) to (3, 4)");
    expect(actionLine({ tool: "press", args: { key: "Escape" }, outcome: {}, at: "t" })).toBe("press Escape");
  });
});
