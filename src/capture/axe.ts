/**
 * The axe accessibility scan, and the shape lookout keeps of what it says.
 *
 * Scoped to the element when one is given. The color-contrast rule is off by
 * default: computed-style contrast over translucent/washed surfaces
 * false-positives heavily; the AI judge sees real pixels instead.
 * --axe-contrast turns it on.
 */
import type { Page } from "playwright";
import type { DeterministicFinding } from "../types.js";

export async function runAxe(
  page: Page,
  includeSelector: string | null,
  opts: { contrast: boolean },
): Promise<DeterministicFinding[]> {
  const { AxeBuilder } = await import("@axe-core/playwright");
  let builder = new AxeBuilder({ page });
  if (includeSelector) builder = builder.include(includeSelector);
  if (!opts.contrast) builder = builder.disableRules(["color-contrast"]);
  const result = await builder.analyze();
  return result.violations.map((v) => ({
    type: "axe-violation" as const,
    severity: v.impact === "critical" || v.impact === "serious" ? ("error" as const) : ("warning" as const),
    message: `${v.id}: ${v.help}`,
    meta: {
      ruleId: v.id,
      impact: v.impact,
      nodeCount: v.nodes.length,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
      helpUrl: v.helpUrl,
      // axe says the same thing at three lengths and lookout used to keep only
      // the shortest, which is why an accessibility ticket could read as its
      // own title repeated. `description` is the sentence a person can follow,
      // and `failureSummary` is axe's own account of what to change on this
      // element. Both are needed to write a ticket somebody can act on without
      // already knowing the rule.
      description: v.description,
      failureSummary: v.nodes
        .slice(0, 3)
        .map((n) => n.failureSummary?.trim())
        .filter((s): s is string => Boolean(s)),
    },
  }));
}
