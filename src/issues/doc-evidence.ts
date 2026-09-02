/**
 * The evidence half of the issue document: the pictures the defect was filed
 * against, and the elements that were rendering it.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { frameAbsPath } from "./frames.js";
import { issueIdsByKey } from "./registry.js";
import { clusterKeyOf } from "../fix/cluster.js";
import { provenanceBrief } from "../design/provenance-brief.js";
import type { IssueContext } from "./context.js";

/** Siblings listed inline before the document points at the backlog instead. */
const SIBLING_CAP = 12;

/** "Where it is" for a source finding, "Look at these first" for a photographed one. */
export function evidenceSection(ctx: IssueContext): string[] {
  const { cluster, resolved, evDir, frames } = ctx;
  const l: string[] = [];
  if (cluster.channel === "code") {
    l.push("## Where it is", "");
    const places = new Set<string>();
    for (const m of cluster.members) {
      if (!m.source) continue;
      const at = `- ${m.source.path}:${m.source.line}${m.source.symbol ? `  (${m.source.symbol})` : ""}`;
      if (places.has(at)) continue;
      places.add(at);
      l.push(at);
    }
    l.push("");
    return l;
  }

  l.push("## Look at these first", "");
  // The frozen frames rather than the live workspace, whenever there are
  // any. The workspace keeps one file per view and overwrites it on every
  // capture, so by the time somebody opens this document its copy of the
  // defect may already be a picture of whatever replaced it. The frames live
  // in this issue's own folder and do not move.
  const where = (f: { route: string; formFactor: string; scheme: string; state?: string }): string =>
    "  " + [`route ${f.route}`, f.formFactor, `${f.scheme} scheme`, f.state ? `state ${f.state}` : ""]
      .filter(Boolean).join(", ");
  if (frames.before.length > 0) {
    for (const f of frames.before) l.push(`- ${frameAbsPath(resolved, cluster.id, f)}`, where(f));
    if (frames.after.length > 0) {
      l.push("", "The same views after the fix lookout ruled on:", "");
      for (const f of frames.after) l.push(`- ${frameAbsPath(resolved, cluster.id, f)}`, where(f));
    }
  } else {
    const seen = new Set<string>();
    for (const m of cluster.members) {
      const ev = m.evidence[m.evidence.length - 1];
      if (!ev || seen.has(ev.path)) continue;
      seen.add(ev.path);
      l.push(`- ${join(evDir, ev.path)}`);
      l.push(`  route ${m.route}, ${m.formFactor}, ${m.scheme} scheme, state ${m.state}`);
    }
  }
  // A list that ends without a blank line welds the next heading onto its
  // last item, and markdown renders the two as one paragraph.
  l.push("");
  return l;
}

/**
 * Where it was rendering, when capture joined the finding to an element.
 * Facts observed on the page, not placement advice; a path is printed only
 * after it is verified to exist, and a member whose file is gone still
 * names its component.
 */
export function rendersSection(ctx: IssueContext): string[] {
  const { cluster, resolved } = ctx;
  const rendered = new Map<string, string>();
  for (const m of cluster.members) {
    const r = m.renderedBy;
    if (!r || (!r.component && !r.file && !r.cssPath)) continue;
    let at = "";
    if (r.file) {
      const abs = isAbsolute(r.file) ? r.file : join(resolved.projectDir, r.file);
      if (existsSync(abs)) at = `  (${abs}${r.line ? `:${r.line}` : ""})`;
    }
    // The component name alone is often a provider or a wrapper, which tells
    // somebody reading the ticket nothing about which element on screen the
    // check actually fired on. The path through the page does, so it is
    // printed underneath whenever it says something the name did not.
    const head = `- ${r.component ?? r.cssPath}${at}`;
    const line = r.component && r.cssPath ? `${head}\n  in the page at \`${r.cssPath}\`` : head;
    rendered.set(line, line);
  }
  // Every element the sidecars can name on these screenshots, whether or not
  // a check joined the finding to one. The judge's findings never carry a
  // renderedBy, so before this they had no section at all.
  const brief = provenanceBrief(ctx.evDir, cluster);
  if (rendered.size === 0 && !brief) return [];
  return [
    "## Where it renders",
    "",
    "Recorded from the running page at capture time: the element each check",
    "fired on, and its source where the page's dev tooling said. A starting",
    "point for finding the code; the section above (when present) says where",
    "the fix belongs.",
    "",
    ...rendered.values(),
    ...(rendered.size > 0 ? [""] : []),
    ...(brief
      ? [
          "The elements the sidecars can name on these screenshots, largest first,",
          "source hints before bare component chains:",
          "",
          brief,
          // Without this the next heading is welded to the last list item and
          // markdown renders the two as one paragraph.
          "",
        ]
      : []),
  ];
}

/**
 * The other open issues filed against the same screenshots. A thrown error or
 * a blank capture on the same picture is often the cause of what this issue
 * describes, and clustering files it under its own number: without this, the
 * two documents never mention each other.
 */
export function siblingsSection(ctx: IssueContext): string[] {
  const { cluster, backlog } = ctx;
  if (!backlog || cluster.channel === "code") return [];
  const mine = new Set(cluster.fingerprints);
  const shotIds = new Set(cluster.members.flatMap((m) => m.evidence.map((e) => e.shotId)));
  const ids = issueIdsByKey(backlog);
  const rows = new Map<string, string>();
  for (const f of Object.values(backlog.findings)) {
    if (mine.has(f.fingerprint)) continue;
    if (f.status !== "open" && f.status !== "blocked") continue;
    if (!f.evidence.some((e) => shotIds.has(e.shotId))) continue;
    const id = ids[clusterKeyOf(f)] ?? "not yet numbered";
    // One line per issue and defect, however many screenshots they share.
    const key = `${id}|${f.attribute}`;
    if (rows.has(key)) continue;
    rows.set(key, `- issue ${id} (${f.severity}, ${f.category}/${f.attribute}): ${f.title}`);
  }
  if (rows.size === 0) return [];
  const all = [...rows.values()].sort();
  const shown = all.slice(0, SIBLING_CAP);
  return [
    "## Also on this screenshot",
    "",
    "Other open findings filed against the same screenshots, each in its own",
    "issue. A thrown error, a failed request or a blank capture on the same",
    "picture is often the cause of what this issue describes. None of them is",
    "closed by fixing this one.",
    "",
    ...shown,
    ...(all.length > shown.length ? [`- and ${all.length - shown.length} more; the backlog lists them all`] : []),
    "",
  ];
}
