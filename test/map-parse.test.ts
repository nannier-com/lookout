// The screen mapper's reply is untrusted: every node that would send somebody
// to a file that is not there, click something the config said never to
// touch, or name a screen twice, is dropped with a note; caps clamp; the
// configured routes are always the roots.
import { describe, expect, test } from "bun:test";
import { parseMapReply } from "../src/map/parse.js";
import { checkNode, normalizeRoute, type NodeCheck, type ParseContext } from "../src/map/parse-node.js";
import { walkNodes } from "../src/map/store.js";

const FILES: Record<string, string> = {
  "/repo/src/App.tsx": "import x from 'y';\nexport function App() {}\nconst Nav = 1;\n",
  "/repo/src/pricing.tsx": "export const PricingPage = () => null;\n",
  "/repo/src/menu.tsx": "export function Menu() {}\n",
};

function ctx(over: Partial<ParseContext> = {}): ParseContext {
  return {
    targets: [
      {
        name: "app",
        url: "http://localhost:3000",
        routes: [
          { path: "/", name: "Home", states: [] },
          { path: "/settings", name: "Settings", states: ["menu-open"] },
        ],
      },
    ],
    recipeNames: new Set(["menu-open"]),
    fold: ["web", "ios"],
    projectDir: "/repo",
    repoRoot: "/repo",
    limits: { maxScreens: 40, maxDepth: 4, maxChildren: 8 },
    exclude: ["Sign out", "/logout"],
    readText: (p) => FILES[p] ?? null,
    ...over,
  };
}

const SRC = { path: "/repo/src/App.tsx", symbol: "App", line: 99 };

function node(id: string, kind: "route" | "state", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind,
    ...(kind === "route" ? { path: id } : {}),
    title: id,
    open: kind === "state" ? { affordance: { role: "button", name: id }, outcome: "overlay" } : null,
    risk: "safe",
    platforms: ["web"],
    source: SRC,
    why: "test",
    children: [],
    ...extra,
  };
}

function reply(screens: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { targets: { app: { screens, skipped: [] } }, examined: ["/repo/src/App.tsx"], ...extra };
}

function ids(roots: ReturnType<typeof parseMapReply>["targets"][string]["roots"]): string[] {
  const out: string[] = [];
  walkNodes(roots, (n, routeAncestor, depth) => out.push(`${depth}:${routeAncestor.path}|${n.kind === "route" ? "rest" : n.id}`));
  return out;
}

/** The check refused, for this reason, fabricated or not. */
function refused(result: NodeCheck, reason: RegExp, fabricated?: boolean): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toMatch(reason);
  if (fabricated !== undefined) expect(result.fabricated ?? false).toBe(fabricated);
}

describe("normalizeRoute", () => {
  test("leading slash, trailing slash off, query and hash off, same-origin URLs reduced to their path", () => {
    expect(normalizeRoute("pricing/", "http://localhost:3000")).toEqual({ path: "/pricing" });
    expect(normalizeRoute("/a?x=1#y", "http://localhost:3000")).toEqual({ path: "/a" });
    expect(normalizeRoute("http://localhost:3000/b/", "http://localhost:3000")).toEqual({ path: "/b" });
    expect(normalizeRoute("/", "http://localhost:3000")).toEqual({ path: "/" });
  });

  test("off-origin and parametrised paths are refused with the reason", () => {
    const reason = (r: ReturnType<typeof normalizeRoute>): string => ("reason" in r ? r.reason : "");
    expect(reason(normalizeRoute("https://example.com/x", "http://localhost:3000"))).toMatch(/off-origin/);
    expect(reason(normalizeRoute("/users/:id", "http://localhost:3000"))).toMatch(/parametrised/);
    expect(reason(normalizeRoute("/blog/[slug]", "http://localhost:3000"))).toMatch(/parametrised/);
    expect(reason(normalizeRoute("", "http://localhost:3000"))).toBe("no path");
  });
});

describe("checkNode", () => {
  const target = ctx().targets[0]!;

  test("the citation is verified: the file's own line for the symbol wins over the reply's", () => {
    const r = checkNode(node("/pricing", "route"), ctx(), target, null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.node.source).toEqual({ path: "/repo/src/App.tsx", symbol: "App", line: 2 });
  });

  test("a file that does not exist, or a symbol that is not in it, is fabrication", () => {
    refused(checkNode(node("/x", "route", { source: { path: "/repo/src/gone.tsx" } }), ctx(), target, null), /does not exist/, true);
    refused(checkNode(node("/x", "route", { source: { path: "/repo/src/App.tsx", symbol: "Nope" } }), ctx(), target, null), /Nope is not in/, true);
    refused(checkNode(node("/x", "route", { source: { path: "/etc/passwd" } }), ctx(), target, null), /outside the repository/, true);
    refused(checkNode(node("/x", "route", { source: { path: "/repo/node_modules/a/index.js" } }), ctx(), target, null), /outside/, true);
    refused(checkNode(node("/x", "route", { source: { path: "/repo/src/App.tsx", symbol: "not an id" } }), ctx(), target, null), /not an identifier/, false);
  });

  test("a relative citation resolves against the project; a line without a symbol is kept when it exists", () => {
    const r = checkNode(node("/x", "route", { source: { path: "src/App.tsx", line: 3 } }), ctx(), target, null);
    expect(r).toMatchObject({ ok: true, node: { source: { path: "/repo/src/App.tsx", line: 3 } } });
    const beyond = checkNode(node("/x", "route", { source: { path: "src/App.tsx", line: 300 } }), ctx(), target, null);
    expect(beyond.ok).toBe(true);
    if (beyond.ok) expect(beyond.node.source.line).toBeUndefined();
  });

  test("state ids: valid names only, never rest, never a hand-written recipe's", () => {
    refused(checkNode(node("Bad Name", "state"), ctx(), target, null), /not a valid state name/);
    refused(checkNode(node("rest", "state"), ctx(), target, null), /not a valid state name/);
    refused(checkNode(node("x", "state"), ctx(), target, null), /not a valid state name/);
    refused(checkNode(node("menu-open", "state"), ctx(), target, null), /hand-written recipe/);
  });

  test("open: a state needs an action with an overlay or in-page outcome; a route opens by navigation or by url", () => {
    refused(checkNode(node("dlg", "state", { open: null }), ctx(), target, null), /needs an `open`/);
    refused(
      checkNode(node("dlg", "state", { open: { affordance: { role: "button", name: "X" }, outcome: "navigation" } }), ctx(), target, null),
      /unknown outcome/,
    );
    refused(checkNode(node("dlg", "state", { open: { outcome: "overlay" } }), ctx(), target, null), /affordance or a tap/);
    const byLink = checkNode(node("/p", "route", { open: { affordance: { role: "link", name: "P", href: "/p" } } }), ctx(), target, null);
    expect(byLink).toMatchObject({ ok: true, node: { open: { outcome: "navigation", affordance: { href: "/p" } } } });
    refused(checkNode(node("/p", "route", { open: { affordance: { role: "link", name: "P" }, outcome: "overlay" } }), ctx(), target, null), /opens by navigation/);
    refused(
      checkNode(node("/p", "route", { open: { affordance: { role: "link", name: "P", href: "https://example.com/p" } } }), ctx(), target, null),
      /off-origin link/,
    );
    const tapped = checkNode(node("sheet", "state", { open: { tap: { label: "More" }, outcome: "overlay" } }), ctx(), target, null);
    expect(tapped).toMatchObject({ ok: true, node: { open: { tap: { label: "More" } } } });
    refused(checkNode(node("/d", "route", { open: { deepLink: "myapp://x" } }), ctx(), target, null), /deepLink must be a path/);
  });

  test("the config's exclusions drop a node by name substring or by path", () => {
    refused(
      checkNode(node("signout", "state", { open: { affordance: { role: "button", name: "Sign out now" }, outcome: "in-page-change" } }), ctx(), target, null),
      /excluded by config/,
    );
    refused(checkNode(node("/logout", "route"), ctx(), target, null), /excluded/);
    expect(checkNode(node("/logout-history", "route"), ctx(), target, null).ok).toBe(true);
  });

  test("risk is clamped and never lower than the parent's; platforms are filtered to the fold or inherited", () => {
    expect(checkNode(node("/a", "route", { risk: "spicy" }), ctx(), target, null)).toMatchObject({ ok: true, node: { risk: "safe" } });
    expect(checkNode(node("/a", "route", { risk: "safe" }), ctx(), target, { risk: "destructive", platforms: ["web"] })).toMatchObject({
      ok: true,
      node: { risk: "destructive" },
    });
    expect(checkNode(node("/a", "route", { platforms: ["android", "web", "desktop"] }), ctx(), target, null)).toMatchObject({ ok: true, node: { platforms: ["web"] } });
    expect(checkNode(node("/a", "route", { platforms: [] }), ctx(), target, { risk: "safe", platforms: ["ios"] })).toMatchObject({ ok: true, node: { platforms: ["ios"] } });
    expect(checkNode(node("/a", "route", { platforms: ["android"] }), ctx(), target, null)).toMatchObject({ ok: true, node: { platforms: ["web", "ios"] } });
    refused(checkNode(node("/a", "route"), ctx({ fold: [] }), target, null), /no platform/);
  });

  test("title and why are bounded; a missing title is the id", () => {
    const r = checkNode(node("/a", "route", { title: "x".repeat(200), why: "y".repeat(500) }), ctx(), target, null);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.node.title).toHaveLength(80);
      expect(r.node.why).toHaveLength(200);
    }
    const untitled = checkNode(node("/a", "route", { title: "" }), ctx(), target, null);
    if (untitled.ok) expect(untitled.node.title).toBe("/a");
  });
});

describe("parseMapReply", () => {
  test("configured routes are the roots in config order, whether or not the reply placed them", () => {
    const parsed = parseMapReply(reply([node("/settings", "route"), node("/x", "route")]), ctx());
    const t = parsed.targets.app!;
    expect(t.roots.map((r) => r.path)).toEqual(["/", "/settings", "/x"]);
    expect(t.roots[0]).toMatchObject({ why: "configured route", open: null, platforms: ["web", "ios"] });
    expect(t.notes).toContain("added: configured route / was not in the reply");
  });

  test("a discovered route nests under the route that links to it; a configured one never nests", () => {
    const parsed = parseMapReply(
      reply([
        node("/", "route", {
          children: [node("/pricing", "route", { open: { affordance: { role: "link", name: "Pricing" } } }), node("/settings", "route")],
        }),
      ]),
      ctx(),
    );
    const t = parsed.targets.app!;
    expect(ids(t.roots)).toEqual(["0:/|rest", "1:/pricing|rest", "0:/settings|rest"]);
    expect(t.notes).toContain("dropped: /settings is a configured route and already a root");
  });

  test("duplicates, cycles, a state used twice under one route, and a top-level state are dropped", () => {
    const parsed = parseMapReply(
      reply([
        node("/", "route", {
          children: [
            node("dlg", "state"),
            node("dlg", "state"),
            node("/p", "route", {
              open: { affordance: { role: "link", name: "P" } },
              children: [node("dlg", "state"), node("/p", "route", { open: { affordance: { role: "link", name: "Again" } } })],
            }),
          ],
        }),
        node("/p", "route"),
        node("orphan", "state"),
      ]),
      ctx(),
    );
    const t = parsed.targets.app!;
    expect(ids(t.roots)).toEqual(["0:/|rest", "1:/|dlg", "1:/p|rest", "2:/p|dlg", "0:/settings|rest"]);
    expect(t.notes).toContain('dropped: state "dlg" is used twice under /');
    expect(t.notes).toContain("dropped: /p is nested under itself");
    expect(t.notes).toContain("dropped: duplicate route /p");
    expect(t.notes).toContain('dropped: top-level state "orphan" has no route above it');
  });

  test("siblings walk safe first, then destructive, then session-destructive, and children inherit", () => {
    const parsed = parseMapReply(
      reply([
        node("/", "route", {
          children: [
            node("delete", "state", { risk: "session-destructive" }),
            node("save", "state", { risk: "destructive", children: [node("confirm", "state", { risk: "safe" })] }),
            node("menu", "state"),
          ],
        }),
      ]),
      ctx(),
    );
    const root = parsed.targets.app!.roots[0]!;
    expect(root.children.map((c) => `${c.id}:${c.risk}`)).toEqual(["menu:safe", "save:destructive", "delete:session-destructive"]);
    expect(root.children[1]!.children[0]).toMatchObject({ id: "confirm", risk: "destructive" });
  });

  test("the caps: depth prunes a subtree, children are cut after ordering, screens are cut breadth first", () => {
    const deep = node("/", "route", {
      children: [node("aa", "state", { children: [node("bb", "state", { children: [node("cc", "state")] })] })],
    });
    const depthCut = parseMapReply(reply([deep]), ctx({ limits: { maxScreens: 40, maxDepth: 2, maxChildren: 8 } }));
    expect(ids(depthCut.targets.app!.roots)).toEqual(["0:/|rest", "1:/|aa", "2:/|bb", "0:/settings|rest"]);
    expect(depthCut.targets.app!.notes.some((n) => /past the depth cap/.test(n))).toBe(true);

    const wide = node("/", "route", { children: [node("zz", "state", { risk: "destructive" }), node("aa", "state"), node("bb", "state")] });
    const childCut = parseMapReply(reply([wide]), ctx({ limits: { maxScreens: 40, maxDepth: 4, maxChildren: 2 } }));
    expect(childCut.targets.app!.roots[0]!.children.map((c) => c.id)).toEqual(["aa", "bb"]);

    // The cap bounds what the map adds; the configured routes are never cut
    // by it, however many the config lists.
    const many = node("/", "route", { children: [node("aa", "state", { children: [node("deep", "state")] }), node("bb", "state")] });
    const screenCut = parseMapReply(reply([many]), ctx({ limits: { maxScreens: 2, maxDepth: 4, maxChildren: 8 } }));
    expect(ids(screenCut.targets.app!.roots)).toEqual(["0:/|rest", "1:/|aa", "1:/|bb", "0:/settings|rest"]);
    expect(screenCut.targets.app!.notes).toContain("pruned: 1 node(s) past the screen cap (2)");
    const onlyRoots = parseMapReply(reply([many]), ctx({ limits: { maxScreens: 0, maxDepth: 4, maxChildren: 8 } }));
    expect(ids(onlyRoots.targets.app!.roots)).toEqual(["0:/|rest", "0:/settings|rest"]);
  });

  test("fabrication is counted apart from the other drops; examined is verified, deduplicated and hashed", () => {
    const parsed = parseMapReply(
      reply([node("/", "route", { children: [node("ghost", "state", { source: { path: "/repo/src/gone.tsx" } }), node("Bad", "state")] })], {
        examined: ["/repo/src/App.tsx", "src/App.tsx", "/repo/src/nowhere.tsx", 42],
      }),
      ctx(),
    );
    expect(parsed.targets.app!.fabricated).toBe(1);
    expect(parsed.targets.app!.notes.filter((n) => n.startsWith("dropped"))).toHaveLength(2);
    expect(parsed.examined).toHaveLength(1);
    expect(parsed.examined[0]).toMatchObject({ path: "src/App.tsx" });
    expect(parsed.examined[0]!.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(parsed.notes).toContain("2 examined path(s) do not exist in the repository");
  });

  test("a single-target scan takes a reply filed under the wrong name, with a note; several names are held to the list", () => {
    const one = ctx({ targets: [ctx().targets[0]!] });
    const misnamed = parseMapReply({ targets: { app_misnamed: { screens: [node("/", "route", { children: [node("dlg", "state")] })], skipped: [] } } }, one);
    expect(misnamed.notes).toContain('the reply named its target "app_misnamed"; taken as "app"');
    expect(ids(misnamed.targets.app!.roots)).toEqual(["0:/|rest", "1:/|dlg", "0:/settings|rest"]);
    const several = parseMapReply({ targets: { other: { screens: [] }, app: { screens: [] } } }, one);
    expect(several.notes).toContain('dropped: unknown target "other"');
  });

  test("unknown targets, junk skipped entries, and a reply that is not an object all degrade to notes", () => {
    const parsed = parseMapReply(
      { targets: { other: {}, app: { screens: [], skipped: [{ what: "/u/:id", reason: "parametrised", source: "src/App.tsx" }, { nope: 1 }] } } },
      ctx(),
    );
    expect(parsed.notes).toContain('dropped: unknown target "other"');
    expect(parsed.targets.app!.skipped).toEqual([{ what: "/u/:id", reason: "parametrised", source: { path: "/repo/src/App.tsx" } }]);
    const junk = parseMapReply("nonsense", ctx());
    expect(junk.targets.app!.roots.map((r) => r.path)).toEqual(["/", "/settings"]);
  });
});
