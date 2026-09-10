/**
 * What the screen mapper is told: the configured targets and routes it seeds
 * from, the fold, the names it must not reuse, the ranked files, and the
 * caps. Paths only, never file contents: the reader opens what it needs with
 * its own tools, and lookout learns what it opened from the reply.
 */
import { renderSkill } from "../skills/load.js";
import type { PlatformKind } from "../types.js";
import { fileBrief, layoutRoutes, type MapCandidate } from "./candidates.js";
import type { ParseTarget } from "./parse-node.js";

export interface MapPromptContext {
  project: string;
  targets: ParseTarget[];
  /** The fold, with a device platform's deep-link scheme when it has one. */
  platforms: { kind: PlatformKind; deepLinkScheme?: string }[];
  configStates: readonly string[];
  excluded: readonly string[];
  candidates: readonly MapCandidate[];
  limits: { maxScreens: number; maxDepth: number; maxChildren: number };
}

function targetsBrief(targets: readonly ParseTarget[]): string {
  return targets
    .map((t) => {
      const routes = t.routes.map(
        (r) => `  - ${r.path}  ${JSON.stringify(r.name)}${r.states.length > 0 ? `  states: ${r.states.join(", ")}` : ""}`,
      );
      return `Target "${t.name}" at ${t.url}, configured routes:\n${routes.join("\n")}`;
    })
    .join("\n");
}

export function buildMapPrompt(skillText: string, ctx: MapPromptContext): string {
  const implied = layoutRoutes(ctx.candidates);
  return renderSkill(skillText, {
    project: ctx.project,
    targets: targetsBrief(ctx.targets),
    platforms: ctx.platforms
      .map((p) => (p.deepLinkScheme ? `${p.kind} (deep links: ${p.deepLinkScheme}://)` : p.kind))
      .join(", "),
    configStates: ctx.configStates.length > 0 ? ctx.configStates.join(", ") : "(none)",
    excluded: ctx.excluded.length > 0 ? ctx.excluded.map((e) => JSON.stringify(e)).join(", ") : "(nothing)",
    files: fileBrief(ctx.candidates),
    layoutRoutes:
      implied.length > 0
        ? implied.map((r) => `${r.path}${r.dynamic ? " (dynamic)" : ""} from ${r.source}`).join("; ")
        : "(none)",
    maxScreens: ctx.limits.maxScreens,
    maxDepth: ctx.limits.maxDepth,
    maxChildren: ctx.limits.maxChildren,
    // The example is keyed by a real target, never a made-up one: a reader
    // copies the example's key, and a made-up name filed a whole reply
    // under a target that did not exist.
    exampleTarget: ctx.targets[0]?.name ?? "app",
  });
}
