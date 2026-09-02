/**
 * The axe accessibility scan, and the shape lookout keeps of what it says.
 *
 * Scoped to the element when one is given. The color-contrast rule is off by
 * default: computed-style contrast over translucent/washed surfaces
 * false-positives heavily; the AI judge sees real pixels instead.
 * --axe-contrast turns it on.
 *
 * axe reports far more than a rule id: the standard the rule belongs to, and
 * for every failing element its markup and the sentence each check wrote. A
 * ticket that says "the `<h5>` reading 'Recent activity'" is one an agent can
 * act on; one that says `main > section:nth-of-type(2) > h5` is one it has to
 * go and resolve first. The markup is summarised at capture, never stored
 * whole: it can carry a row of somebody's data, and the folder it ends up in
 * is committed with the project.
 */
import type { Page } from "playwright";
import type { DeterministicFinding } from "../types.js";

/** What lookout keeps of one failing element's markup. */
export interface ElementSummary {
  tag: string;
  /** A few naming attributes; nothing that could carry a value or a payload. */
  attrs: Record<string, string>;
  /** Visible text, whitespace collapsed, at most 80 characters. */
  text: string;
}

const KEEP_ATTRS = ["id", "class", "role", "aria-label", "aria-labelledby", "aria-describedby", "name", "type", "for", "data-testid", "alt", "title", "href"];
const MAX_TEXT = 80;
const MAX_ATTR = 80;
const MAX_CLASSES = 3;
const MAX_NODES = 20;
const MAX_CHECKS = 4;
const MAX_TAGS = 10;

/**
 * The tag, a few naming attributes, and the visible text. Everything else in
 * the markup (values, sources, styles, handlers, other data attributes, nested
 * elements) is dropped here, before it is written anywhere.
 */
export function summariseHtml(html: string): ElementSummary {
  const open = /^\s*<([a-zA-Z][\w-]*)([^>]*)>/.exec(html);
  const tag = open?.[1]?.toLowerCase() ?? "element";
  const attrs: Record<string, string> = {};
  const attrText = open?.[2] ?? "";
  const re = /([\w:-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrText)) !== null) {
    const name = m[1]!.toLowerCase();
    if (!KEEP_ATTRS.includes(name)) continue;
    let value = (m[3] ?? m[4] ?? m[5] ?? "").trim();
    if (name === "class") value = value.split(/\s+/).filter(Boolean).slice(0, MAX_CLASSES).map((c) => c.slice(0, 40)).join(" ");
    if (name === "href") {
      // Origin and path only: a query string is where tokens travel.
      try {
        const u = new URL(value, "http://placeholder.invalid");
        value = u.origin === "http://placeholder.invalid" ? u.pathname : `${u.origin}${u.pathname}`;
      } catch {
        value = value.split(/[?#]/)[0] ?? "";
      }
    }
    if (value !== "") attrs[name] = value.slice(0, MAX_ATTR);
  }
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  return { tag, attrs, text };
}

/** The slice of an axe violation lookout reads, typed structurally so the mapper needs no axe types. */
export interface AxeViolation {
  id: string;
  impact?: string | null;
  help: string;
  helpUrl: string;
  description: string;
  tags: string[];
  nodes: {
    target: unknown[];
    html: string;
    impact?: string | null;
    failureSummary?: string;
    any: { message: string }[];
    all: { message: string }[];
    none: { message: string }[];
  }[];
}

/** One violation as a finding: the message names the rule, the record keeps everything a fixer needs. */
export function axeFinding(v: AxeViolation): DeterministicFinding {
  const targets = v.nodes.slice(0, 3).map((n) => n.target.map(String).join(" "));
  const failureSummary = v.nodes
    .slice(0, 3)
    .map((n) => n.failureSummary?.trim())
    .filter((s): s is string => Boolean(s));
  const nodes = v.nodes.slice(0, MAX_NODES).map((n) => {
    const checks = [...new Set([...n.any, ...n.all, ...n.none].map((c) => c.message?.trim()).filter(Boolean))].slice(0, MAX_CHECKS);
    return {
      target: n.target.map(String).join(" "),
      ...(n.impact ? { impact: n.impact } : {}),
      element: summariseHtml(n.html ?? ""),
      ...(checks.length > 0 ? { checks } : {}),
    };
  });
  return {
    type: "axe-violation",
    severity: v.impact === "critical" || v.impact === "serious" ? "error" : "warning",
    message: `${v.id}: ${v.help}`,
    meta: {
      ruleId: v.id,
      impact: v.impact,
      nodeCount: v.nodes.length,
      targets,
      helpUrl: v.helpUrl,
      // axe says the same thing at three lengths and lookout used to keep only
      // the shortest, which is why an accessibility ticket could read as its
      // own title repeated. `description` is the sentence a person can follow,
      // and `failureSummary` is axe's own account of what to change on this
      // element. Both are needed to write a ticket somebody can act on without
      // already knowing the rule.
      description: v.description,
      failureSummary,
      tags: v.tags.slice(0, MAX_TAGS),
      nodes,
    },
  };
}

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
  return result.violations.map((v) => axeFinding(v as unknown as AxeViolation));
}
