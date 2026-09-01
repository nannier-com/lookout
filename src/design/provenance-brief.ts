/**
 * What was rendering on a defect's screenshots, as the placement skill sees
 * it: observed facts read back from the capture-time provenance sidecars,
 * never conclusions about the repository. The brief is a starting point for
 * the placement advisor's own reading; its skill tells it to open every
 * named file before trusting it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSidecar, type ProvenanceElement, type ProvenanceSidecar } from "../capture/provenance.js";
import type { FixCluster } from "../fix/cluster.js";

/** A shot's sidecar, by the convention store.ts writes; null when absent or foreign. */
export function loadSidecarBeside(evDir: string, pngRelPath: string): ProvenanceSidecar | null {
  const p = join(evDir, `${pngRelPath}.provenance.json`);
  if (!existsSync(p)) return null;
  try {
    return parseSidecar(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const MAX_SIDECARS = 3;
const MAX_SOURCED = 8;
const MAX_CHAINS = 4;

function line(e: ProvenanceElement): string {
  const name = e.components.length > 0 ? e.components.join(" < ") : e.tag;
  const src = e.source ? `  ${e.source.file}${e.source.line ? `:${e.source.line}` : ""}` : "";
  const idBit = e.id ? `#${e.id}` : e.testid ? `[data-testid=${JSON.stringify(e.testid)}]` : "";
  const txt = e.text ? ` "${e.text.slice(0, 40)}"` : "";
  return `- ${name}${src}  (${e.tag}${idBit}${txt})`;
}

/**
 * The {{provenance}} block for one cluster: up to three of its evidence
 * shots, each listing the elements that can name code (source hints first,
 * bare component chains after). Empty string when no sidecar contributes
 * anything; the caller substitutes the skill's sentinel.
 */
export function provenanceBrief(evDir: string, cluster: FixCluster): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of cluster.members) {
    if (seen.size >= MAX_SIDECARS) break;
    const ev = m.evidence[m.evidence.length - 1];
    if (!ev || seen.has(ev.path)) continue;
    seen.add(ev.path);
    const sc = loadSidecarBeside(evDir, ev.path);
    if (!sc) continue;

    const area = (e: ProvenanceElement): number => e.box.w * e.box.h;
    const sourced = sc.elements
      .filter((e) => e.source)
      .sort((a, b) => area(b) - area(a))
      .slice(0, MAX_SOURCED);
    const chains: ProvenanceElement[] = [];
    const chainSeen = new Set<string>();
    for (const e of sc.elements.sort((a, b) => area(b) - area(a))) {
      if (e.source || e.components.length === 0) continue;
      const key = e.components.join(">");
      if (chainSeen.has(key)) continue;
      chainSeen.add(key);
      chains.push(e);
      if (chains.length >= MAX_CHAINS) break;
    }
    if (sourced.length === 0 && chains.length === 0) continue;

    const drift =
      sc.shotHash !== ev.hash ? "  (re-captured since this evidence; layout may have moved)" : "";
    if (out.length > 0) out.push("");
    out.push(`shot ${sc.shotId}: route ${m.route}, ${m.formFactor}, ${m.scheme}${drift}`);
    // The finding's own capture-time join outranks the area ranking: this IS
    // the element the check fired on.
    if (m.renderedBy) {
      const r = m.renderedBy;
      const at = r.file ? `  ${r.file}${r.line ? `:${r.line}` : ""}` : "";
      out.push(`- THIS FINDING'S ELEMENT: ${r.component ?? r.selector}${at}  (${r.cssPath})`);
    }
    out.push(...sourced.map(line), ...chains.map(line));
  }
  return out.join("\n");
}
