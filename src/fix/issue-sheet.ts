/**
 * One contact sheet per issue.
 *
 * A root cause usually shows on several screenshots at once, and the point of
 * grouping them is that somebody can see the whole defect in one image rather
 * than opening six. lookout documents issues; this is what that documentation
 * looks like when the evidence is pixels.
 */
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import { buildContactSheet, sheetNote } from "../capture/sheet.js";
import type { ResolvedConfig } from "../types.js";
import type { FixCluster } from "./cluster.js";

/** One sheet per issue, so its whole defect can be seen in a single image. */
export async function clusterSheet(
  resolved: ResolvedConfig,
  c: FixCluster,
): Promise<string | null> {
  const evDir = evidenceDir(resolved);
  const seen = new Set<string>();
  const tiles = [];
  for (const m of c.members) {
    const ev = m.evidence[m.evidence.length - 1];
    if (!ev || seen.has(ev.path)) continue;
    seen.add(ev.path);
    tiles.push({
      shot: {
        target: m.target,
        route: m.route,
        state: m.state,
        formFactor: m.formFactor,
        scheme: m.scheme,
        path: ev.path,
      },
      findings: 1,
    });
  }
  const res = await buildContactSheet(tiles, evDir, join(evDir, "fix", `${c.id}.sheet.png`));
  return res?.path ?? null;
}

export { sheetNote };
