// Which files the screen mapper is pointed at: routers outrank link-dense
// screens which outrank plain components; the machine-read files are never
// offered; the file layout's own routes are read off the paths.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileBrief, layoutRoute, layoutRoutes, mapCandidates } from "../src/map/candidates.js";
import { tmpProject } from "./tmp-project.js";

function write(root: string, rel: string, text: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
}

describe("layoutRoute", () => {
  test("reads a route off a Next app or pages file, a SvelteKit page, and an expo-router screen", () => {
    expect(layoutRoute("app/pricing/page.tsx")).toEqual({ path: "/pricing", dynamic: false });
    expect(layoutRoute("src/app/(marketing)/about/page.tsx")).toEqual({ path: "/about", dynamic: false });
    expect(layoutRoute("pages/blog/[slug].tsx")).toEqual({ path: "/blog/[slug]", dynamic: true });
    expect(layoutRoute("pages/index.tsx")).toEqual({ path: "/", dynamic: false });
    expect(layoutRoute("src/routes/settings/+page.svelte")).toEqual({ path: "/settings", dynamic: false });
    expect(layoutRoute("app/settings/index.tsx")).toEqual({ path: "/settings", dynamic: false });
  });

  test("layouts, api routes, underscore files and plain components are not routes", () => {
    expect(layoutRoute("app/layout.tsx")).toBeNull();
    expect(layoutRoute("app/_layout.tsx")).toBeNull();
    expect(layoutRoute("pages/_app.tsx")).toBeNull();
    expect(layoutRoute("pages/api/users.ts")).toBeNull();
    expect(layoutRoute("src/routes/settings/+layout.svelte")).toBeNull();
    expect(layoutRoute("src/components/Button.tsx")).toBeNull();
  });
});

describe("mapCandidates", () => {
  test("a router outranks a link-dense screen which outranks a plain component; tests and stories are never offered", async () => {
    const r = tmpProject("lookout-map-cand-");
    const root = r.projectDir;
    write(root, "src/router.tsx", "import { createBrowserRouter } from 'react-router-dom';\nexport const router = createBrowserRouter([{ path: '/', element: 1 }, { path: '/pricing', element: 2 }]);\n");
    write(root, "src/pages/Home.tsx", "import { Link } from 'react-router-dom';\nexport function Home() { return <div><Link to=\"/pricing\">Pricing</Link><Link to=\"/about\">About</Link><Dialog open /></div>; }\n");
    write(root, "src/components/Button.tsx", "export function Button() { return <button onClick={() => 1}>x</button>; }\n");
    write(root, "src/components/Plain.tsx", "export const Plain = () => <div>plain</div>;\n");
    write(root, "src/pages/Home.test.tsx", "import { Link } from 'x'; <Link to=\"/a\" />;\n");
    write(root, "src/pages/Home.stories.tsx", "import { Link } from 'x'; <Link to=\"/a\" />;\n");
    write(root, "node_modules/lib/index.js", "createBrowserRouter([{ path: '/x' }]);\n");

    const out = await mapCandidates(r, 60);
    const rels = out.map((c) => c.relPath);
    expect(rels[0]).toBe("src/router.tsx");
    expect(rels.indexOf("src/pages/Home.tsx")).toBeLessThan(rels.indexOf("src/components/Button.tsx"));
    expect(rels).not.toContain("src/components/Plain.tsx");
    expect(rels).not.toContain("src/pages/Home.test.tsx");
    expect(rels).not.toContain("src/pages/Home.stories.tsx");
    expect(rels.some((p) => p.includes("node_modules"))).toBe(false);
    expect(out[0]!.marks).toContain("router");
    expect(out.find((c) => c.relPath === "src/pages/Home.tsx")!.marks).toEqual(["links", "overlays", "route /Home"]);
    expect(out[0]!.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("the budget slices best first, and zero means zero", async () => {
    const r = tmpProject("lookout-map-budget-");
    write(r.projectDir, "src/router.tsx", "createBrowserRouter([{ path: '/' }]);\n");
    write(r.projectDir, "src/Nav.tsx", "<Link to=\"/a\" />\n");
    expect((await mapCandidates(r, 1)).map((c) => c.relPath)).toEqual(["src/router.tsx"]);
    expect(await mapCandidates(r, 0)).toEqual([]);
  });

  test("layoutRoutes reads the layout's routes off the candidates, once each, and the brief carries paths only", async () => {
    const r = tmpProject("lookout-map-layout-");
    write(r.projectDir, "app/pricing/page.tsx", "export default function Pricing() { return <a href=\"/\">home</a>; }\n");
    write(r.projectDir, "app/blog/[slug]/page.tsx", "export default function Post() { return <a href=\"/\">home</a>; }\n");
    const out = await mapCandidates(r, 60);
    expect(layoutRoutes(out).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "/blog/[slug]", source: "app/blog/[slug]/page.tsx", dynamic: true },
      { path: "/pricing", source: "app/pricing/page.tsx", dynamic: false },
    ]);
    const brief = fileBrief(out);
    expect(brief).toContain("- " + join(r.projectDir, "app/pricing/page.tsx") + "  (links, route /pricing)");
    expect(brief).not.toContain("export default");
    expect(fileBrief([])).toContain("no route-bearing source files");
  });
});
