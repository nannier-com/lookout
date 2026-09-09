/**
 * Which source files are worth the screen mapper's attention, and how they
 * are described to it.
 *
 * An application has hundreds of source files and its screens are declared
 * in a handful of them: the router, the page or screen directories, the
 * navigation components that link them together. The ranking pulls those to
 * the front so the reader can start at the router and follow imports rather
 * than read the repository. Platform knowledge only; nothing here names a
 * project.
 */
import { readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { hashText } from "../design/conformance-cache.js";
import { NOT_APPLICATION_UI } from "../design/conformance-candidates.js";
import { appSourceRoots } from "../design/detect.js";
import { appSourceFiles, sourceFiles } from "../design/detect-tree.js";
import type { ResolvedConfig } from "../types.js";
import { DEFAULT_MAP_FILE_BUDGET } from "./store.js";

export interface MapCandidate {
  path: string;
  relPath: string;
  score: number;
  /** What the file carries, for the brief: router, links, overlays, a layout route. */
  marks: string[];
  /** sha1 of the content, for the map's signature. */
  hash: string;
}

/** Route declarations: the routers of the frameworks lookout meets. */
const ROUTER =
  /createBrowserRouter|createRoutesFromElements|<Routes?[\s>]|RouterProvider|create(?:Native)?StackNavigator|createBottomTabNavigator|createDrawerNavigator|createMaterialTopTabNavigator|<(?:Stack|Tabs|Drawer)\.Screen|<(?:Stack|Tabs|Drawer)[\s>]|expo-router|createRouter\(|createWebHistory|RouterModule\.for(?:Root|Child)|loadChildren|routes\s*[:=]\s*\[|\bpath:\s*["'`]/g;

/** Where one screen leads to another. */
const LINK =
  /<(?:Link|NavLink|RouterLink)[\s>]|<a\s[^>]*href=|href=\{|\bnavigate\(|router\.(?:push|replace)\(|useNavigation\(|useRouter\(|Linking\.openURL|navigation\.navigate\(|\bredirect\(|\bto=["'{]/g;

/** What a screen shows only after an action. */
const OVERLAY = /<(?:Dialog|Modal|Drawer|Sheet|Popover|Tabs|Menu)[\s.>]|role=["'](?:dialog|menu|tab)|onPress=|onClick=/g;

const ROUTER_NAME = /^(?:router|routes|routing|navigation|navigator|app)\./i;

/**
 * A file whose place in the tree names a route: Next's `app/**\/page.*` and
 * `pages/**`, SvelteKit's `routes/**\/+page.svelte`, Nuxt's `pages/**`,
 * expo-router's `app/**`.
 */
export function layoutRoute(relPath: string): { path: string; dynamic: boolean } | null {
  const m = /(?:^|\/)(app|pages|routes)\/(.+?)(?:\/\+page\.svelte|\/page\.[tj]sx?|\/index\.[tj]sx?|\.[tj]sx?|\.vue|\.svelte)$/.exec(relPath);
  if (!m) return null;
  const dir = m[1]!;
  const inner = m[2]!;
  if (dir === "routes" && !/\+page\.svelte$/.test(relPath)) return null;
  if (dir === "app" && !/\/page\.[tj]sx?$|\/index\.[tj]sx?$|\.[tj]sx$/.test(relPath)) return null;
  if (/^_|\/_|^api\/|\/api\//.test(inner)) return null;
  const raw = inner.split("/");
  // A layout file wraps routes; it is not one.
  if (/^(?:\+?_?layout)$/.test(raw[raw.length - 1] ?? "")) return null;
  const segments = raw.filter((s) => !/^\(.*\)$/.test(s) && s !== "index" && s !== "page");
  const dynamic = segments.some((s) => /^\[.*\]$|^:|\*/.test(s));
  const path = "/" + segments.join("/");
  return { path: path.replace(/\/+/g, "/"), dynamic };
}

function score(relPath: string, text: string): { score: number; marks: string[] } {
  const marks: string[] = [];
  let total = 0;
  const router = (text.match(ROUTER) ?? []).length;
  const links = (text.match(LINK) ?? []).length;
  const overlays = (text.match(OVERLAY) ?? []).length;
  if (router > 0) marks.push("router");
  if (links > 0) marks.push("links");
  if (overlays > 0) marks.push("overlays");
  total += router * 10 + links * 3 + overlays;
  const layout = layoutRoute(relPath);
  if (layout) {
    marks.push(`route ${layout.path}${layout.dynamic ? " (dynamic)" : ""}`);
    total += 20;
  }
  if (/(?:^|\/)_layout\.[tj]sx?$/.test(relPath)) total += 25;
  if (ROUTER_NAME.test(basename(relPath))) total += 15;
  return { score: total, marks };
}

/** Files worth offering, best first, within the budget. Zero means zero. */
export async function mapCandidates(
  resolved: ResolvedConfig,
  budget = DEFAULT_MAP_FILE_BUDGET,
): Promise<MapCandidate[]> {
  const projectDir = resolved.projectDir;
  const roots = await appSourceRoots(projectDir);
  const files = new Set<string>([
    ...(await appSourceFiles(roots)),
    // The router and the app shell often sit right under src/ or the root:
    // src/App.tsx, src/router.ts, app/_layout.tsx.
    ...(await sourceFiles(join(projectDir, "src"), 2)),
    ...(await sourceFiles(projectDir, 1)),
  ]);
  const out: MapCandidate[] = [];
  for (const file of files) {
    if (NOT_APPLICATION_UI.test(file)) continue;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const relPath = relative(projectDir, file);
    const s = score(relPath, text);
    if (s.score === 0) continue;
    out.push({ path: file, relPath, score: s.score, marks: s.marks, hash: hashText(text) });
  }
  out.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.relPath.localeCompare(b.relPath)));
  return out.slice(0, Math.max(0, budget));
}

/** The routes the file layout implies, deduplicated, for the brief. */
export function layoutRoutes(candidates: readonly MapCandidate[]): { path: string; source: string; dynamic: boolean }[] {
  const seen = new Map<string, { path: string; source: string; dynamic: boolean }>();
  for (const c of candidates) {
    const r = layoutRoute(c.relPath);
    if (r && !seen.has(r.path)) seen.set(r.path, { path: r.path, source: c.relPath, dynamic: r.dynamic });
  }
  return [...seen.values()];
}

/** The candidate list as the skill sees it: paths and what each carries, never contents. */
export function fileBrief(candidates: readonly MapCandidate[]): string {
  if (candidates.length === 0) return "- (no route-bearing source files were found; read from the project root)";
  return candidates.map((c) => `- ${c.path}  (${c.marks.join(", ")})`).join("\n");
}
