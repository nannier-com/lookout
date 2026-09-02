/**
 * Reading each shot's accessibility tree back off disk for the judge.
 *
 * Separate from the capture that wrote it and from the prompt that carries it,
 * because this is the only place that knows a missing tree is normal. A native
 * capture has no DOM, a snapshot can fail, and an older report predates the
 * sidecar entirely; in every one of those cases the shot is judged from its
 * pixels exactly as before and the prompt says nothing about a tree, rather
 * than promising one and showing an empty block.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAriaSidecar, promptTree } from "../capture/aria.js";
import type { AriaEvidence } from "./engine.js";
import type { ShotRecord } from "../types.js";

export async function loadAriaFor(
  shots: readonly ShotRecord[],
  evidenceDir: string,
): Promise<Map<string, AriaEvidence>> {
  const out = new Map<string, AriaEvidence>();
  for (const shot of shots) {
    if (!shot.aria) continue;
    try {
      const sidecar = parseAriaSidecar(await readFile(join(evidenceDir, shot.aria), "utf8"));
      if (!sidecar) continue;
      out.set(shot.id, { yaml: promptTree(sidecar), hash: sidecar.hash });
    } catch {
      // A sidecar that is gone leaves the shot judged from its pixels.
    }
  }
  return out;
}
