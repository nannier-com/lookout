/**
 * The in-page half of rendering provenance: one self-contained collector
 * passed to page.evaluate, per the harvest.ts pattern. Everything pure
 * (types, ranking, the sidecar, the deterministic join) lives in
 * provenance-sidecar.ts and is re-exported here so callers keep one
 * import point.
 */
export {
  attachProvenance,
  buildSidecar,
  loadSidecarBeside,
  parseSidecar,
  pngBoxOf,
  PROVENANCE_VERSION,
  selectorsOf,
  type ProvenanceElement,
  type ProvenanceRef,
  type ProvenanceSidecar,
  type RawProvenance,
} from "./provenance-sidecar.js";
import type { RawProvenance } from "./provenance-sidecar.js";
import type { ProvenanceElement } from "./provenance-sidecar.js";

/** Runs in the browser. Self-contained: no closure over module scope. */
export function collectProvenanceInPage(args: {
  rootSelector: string | null;
  maxElements: number;
  resolve: string[];
}): RawProvenance {
  const doc = document.documentElement;
  const root: Element =
    (args.rootSelector ? document.querySelector(args.rootSelector) : null) ?? doc;
  const sx = window.scrollX;
  const sy = window.scrollY;

  const chainOf = (el: Element): { components: string[]; source?: { file: string; line?: number } } => {
    const components: string[] = [];
    let source: { file: string; line?: number } | undefined;
    // React dev builds: any own key starting __reactFiber$ reaches the fiber
    // tree; names survive on function/class component types, and pre-React-19
    // builds carry _debugSource {fileName, lineNumber}.
    try {
      const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
      if (key) {
        type Fiber = {
          type?: { displayName?: string; name?: string } | string | null;
          _debugSource?: { fileName?: string; lineNumber?: number };
          return?: Fiber | null;
        };
        let f: Fiber | null = (el as unknown as Record<string, Fiber>)[key] ?? null;
        for (let depth = 0; f && depth < 20; depth += 1) {
          const t = f.type;
          if (t && typeof t !== "string") {
            const name = t.displayName ?? t.name;
            if (name && components.length < 5 && !components.includes(name)) components.push(name);
          }
          const dbg = f._debugSource;
          if (!source && dbg?.fileName) source = { file: dbg.fileName, line: dbg.lineNumber };
          f = f.return ?? null;
        }
      }
    } catch {
      // an exotic fiber shape never costs the shot
    }
    // Vue: __vueParentComponent chains carry type.name / type.__file.
    try {
      type VueComp = { type?: { name?: string; __file?: string }; parent?: VueComp | null };
      let c: VueComp | null =
        (el as unknown as { __vueParentComponent?: VueComp }).__vueParentComponent ?? null;
      for (let depth = 0; c && depth < 10; depth += 1) {
        const file = c.type?.__file;
        const name = c.type?.name ?? (file ? file.split("/").pop() ?? "" : "");
        if (name && components.length < 5 && !components.includes(name)) components.push(name);
        if (!source && file) source = { file };
        c = c.parent ?? null;
      }
    } catch {
      // same stance
    }
    // Svelte dev builds stamp the element itself.
    try {
      const meta = (el as unknown as { __svelte_meta?: { loc?: { file?: string; line?: number } } })
        .__svelte_meta;
      if (!source && meta?.loc?.file) source = { file: meta.loc.file, line: meta.loc.line };
    } catch {
      // same stance
    }
    // Build-tool data attributes, the durable layer production can keep.
    try {
      const ds = el.getAttribute("data-source");
      if (!source && ds) {
        const m = /^(.*?):(\d+)$/.exec(ds);
        source = m ? { file: m[1]!, line: Number(m[2]) } : { file: ds };
      }
      const path = el.getAttribute("data-inspector-relative-path");
      if (!source && path) {
        const line = Number(el.getAttribute("data-inspector-line") ?? "");
        source = Number.isFinite(line) && line > 0 ? { file: path, line } : { file: path };
      }
      for (const attr of ["data-sentry-component", "data-component"]) {
        const name = el.getAttribute(attr);
        if (name && components.length < 5 && !components.includes(name)) components.push(name);
      }
    } catch {
      // same stance
    }
    return source ? { components, source } : { components };
  };

  const LANDMARKS = ["header", "nav", "main", "footer", "aside"];
  const LANDMARK_ROLES = ["banner", "navigation", "main", "contentinfo", "complementary"];
  const INTERACTIVE = ["button", "a", "input", "select", "textarea", "summary"];

  const all: Element[] = [root, ...Array.from(root.querySelectorAll("*"))];
  const out: ProvenanceElement[] = [];
  const collected = new Map<Element, number>();
  let truncated = false;
  for (const el of all) {
    if (out.length >= args.maxElements) {
      truncated = true;
      break;
    }
    const he = el as HTMLElement;
    const style = window.getComputedStyle(he);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = he.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const hints = chainOf(el);
    const landmark =
      LANDMARKS.includes(tag) || (role !== null && LANDMARK_ROLES.includes(role));
    const interesting =
      hints.source !== undefined ||
      hints.components.length > 0 ||
      !!el.id ||
      el.getAttribute("data-testid") !== null ||
      el.getAttribute("aria-label") !== null ||
      landmark ||
      /^h[1-6]$/.test(tag) ||
      tag === "img" ||
      INTERACTIVE.includes(tag) ||
      (role !== null && ["button", "link", "tab"].includes(role));
    if (!interesting) continue;

    // The 8-segment nth-of-type path builder. Deliberately duplicated from
    // navigate/harvest.ts collectInPage: in-page functions are self-contained
    // by rule, so they cannot share an import.
    const segs: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body && segs.length < 8) {
      if (cur.id) {
        segs.unshift(`#${cur.id}`);
        break;
      }
      const parent: Element | null = cur.parentElement;
      let nth = 1;
      if (parent) {
        for (const sib of Array.from(parent.children)) {
          if (sib === cur) break;
          if (sib.tagName === cur.tagName) nth += 1;
        }
      }
      segs.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${nth})`);
      cur = parent;
    }

    const text = (he.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80);
    collected.set(el, out.length);
    out.push({
      tag,
      id: el.id || null,
      testid: el.getAttribute("data-testid"),
      role,
      classes: Array.from(el.classList)
        .slice(0, 5)
        .map((c) => c.slice(0, 60)),
      text: text || null,
      cssPath: segs.join(" > "),
      landmark,
      box: {
        x: Math.round((rect.x + sx) * 10) / 10,
        y: Math.round((rect.y + sy) * 10) / 10,
        w: Math.round(rect.width * 10) / 10,
        h: Math.round(rect.height * 10) / 10,
      },
      ...hints,
    });
  }

  // Selector resolution: each caller-supplied selector maps to the collected
  // element it hits, or its nearest collected ancestor, by node identity.
  const resolved: Record<string, number> = {};
  for (const sel of args.resolve) {
    try {
      let node: Element | null = document.querySelector(sel);
      while (node && !collected.has(node)) node = node.parentElement;
      if (node) resolved[sel] = collected.get(node)!;
    } catch {
      // an unparseable selector resolves to nothing, silently by design
    }
  }

  const rootRect = root.getBoundingClientRect();
  const isDoc = root === doc;
  return {
    devicePixelRatio: window.devicePixelRatio,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { x: sx, y: sy },
    document: { width: doc.scrollWidth, height: doc.scrollHeight },
    originBox: isDoc
      ? { x: 0, y: 0, w: doc.scrollWidth, h: doc.scrollHeight }
      : {
          x: Math.round((rootRect.x + sx) * 10) / 10,
          y: Math.round((rootRect.y + sy) * 10) / 10,
          w: Math.round(rootRect.width * 10) / 10,
          h: Math.round(rootRect.height * 10) / 10,
        },
    elements: out,
    resolved,
    truncated,
  };
}
