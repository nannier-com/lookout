/**
 * Writing an amendment down instead of applying it.
 *
 * Every path that reaches here is the same decision: the frozen set cannot
 * grade this change, and auto-applying something nothing can grade is the exact
 * thing the gate exists to prevent. A brand-new skill is ungradeable by
 * definition; so is an amendment to a skill the set cannot exercise, or to a
 * panel whose lane holds no frozen claims. What lands is a file a person reads,
 * and a history entry saying it happened.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { projectProposalPath } from "./load.js";
import { record } from "./history.js";
import { nowIso } from "../util.js";
import type { ResolvedConfig } from "../types.js";

/** Write the proposal and record it. Returns the path it landed at. */
export async function propose(
  resolved: ResolvedConfig,
  skill: string,
  body: string,
  entry: { summary: string; evidence: string[] },
): Promise<string> {
  const p = projectProposalPath(resolved, skill);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, body);
  await record(resolved, {
    at: nowIso(),
    skill,
    action: "proposed",
    summary: entry.summary,
    evidence: entry.evidence,
  });
  return p;
}
