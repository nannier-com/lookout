/**
 * Plain-language prose for a deterministic finding.
 *
 * A check fires with a message written to be precise, not to be understood:
 * "heading-order: Heading levels should only increase by one" tells an agent
 * which rule failed and tells a person nothing at all. Ingestion used to copy
 * that one string into both the title and the problem, so the ticket's "what
 * is wrong" section printed the heading, the metadata, and then the heading
 * again. This is where the second half of that section comes from.
 *
 * Two rules govern everything here:
 *
 * - **It is lookout's own vocabulary being explained, never a project's.** These
 *   are lookout's checks and axe's rules. Nothing in this file may know what
 *   application it is looking at.
 * - **Nothing is invented.** Every sentence is either a restatement of what the
 *   check itself measured or of what the tool that raised it says about its own
 *   rule. Where a check gives nothing to expand on, its message stands alone
 *   rather than being padded with a guess.
 */
import type { DeterministicFinding } from "../types.js";

export interface Prose {
  /**
   * One line naming the defect, in words rather than the check's message: the
   * message leads with a rule id or a measurement, and a title is printed on
   * its own, on a card, in a list, in a commit.
   */
  title: string;
  /** The two-part explanation: what a person would notice, then the detail. */
  problem: string;
  /** The fixed state, as a sentence. Empty when the check cannot phrase one. */
  expected: string;
  /** What this capture actually showed. Empty when the message already is it. */
  observed: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];

/** One sentence, terminated once. axe punctuates some of its strings and not others. */
const sentence = (s: string): string => {
  const t = s.trim();
  return t === "" || /[.!?]$/.test(t) ? t : `${t}.`;
};

/**
 * axe's own severity words, said in full. axe defines these four and a ticket
 * that prints the bare word is asking its reader to already know the scale.
 */
const AXE_IMPACT: Record<string, string> = {
  critical: "axe rates this critical, which lookout files as high: it stops somebody using assistive technology from getting at the content at all.",
  serious: "axe rates this serious, which lookout files as high: it makes the affected content very hard to use with assistive technology.",
  moderate: "axe rates this moderate, which lookout files as medium: it frustrates somebody using assistive technology without stopping them outright.",
  minor: "axe rates this minor, which lookout files as medium: it is a nuisance rather than a barrier.",
};

interface AxeNode {
  element: { tag: string; attrs: Record<string, string>; text: string };
  checks: string[];
}

/** The failing elements the capture kept, in the shape axe.ts writes them. */
function axeNodes(v: unknown): AxeNode[] {
  if (!Array.isArray(v)) return [];
  const out: AxeNode[] = [];
  for (const n of v) {
    if (typeof n !== "object" || n === null) continue;
    const el = (n as { element?: { tag?: unknown; attrs?: unknown; text?: unknown } }).element;
    if (!el || typeof el.tag !== "string") continue;
    out.push({
      element: {
        tag: el.tag,
        attrs: typeof el.attrs === "object" && el.attrs !== null ? (el.attrs as Record<string, string>) : {},
        text: typeof el.text === "string" ? el.text : "",
      },
      checks: list((n as { checks?: unknown }).checks),
    });
  }
  return out;
}

/** An element as a person would point at it: its tag, the one attribute that names it, the words on it. */
function elementPhrase(e: AxeNode["element"]): string {
  const naming = ["id", "aria-label", "alt", "name", "data-testid"].find((k) => e.attrs[k]);
  const attr = naming ? ` ${naming}="${e.attrs[naming]}"` : "";
  const text = e.text ? ` reading "${e.text.length > 40 ? `${e.text.slice(0, 40)}…` : e.text}"` : "";
  return `the \`<${e.tag}${attr}>\`${text}`;
}

/**
 * Which standard the rule belongs to, from axe's own tags: a WCAG conformance
 * level is a requirement, a best-practice tag alone is advice. Nothing about
 * policy or law, which would be invention.
 */
function standardOf(tags: string[]): string {
  const levels = tags
    .map((t) => /^wcag(\d)(\d)?(a{1,3})$/.exec(t))
    .filter((r): r is RegExpExecArray => r !== null)
    .map((r) => ({ version: r[2] ? `${r[1]}.${r[2]}` : `${r[1]}.0`, level: r[3]!.toUpperCase() }));
  if (levels.length > 0) {
    const best = levels.sort((a, b) => a.version.localeCompare(b.version))[0]!;
    return `It is a WCAG ${best.version} level ${best.level} requirement.`;
  }
  if (tags.includes("best-practice")) return "It is an axe best-practice rule rather than a WCAG requirement.";
  return "";
}

/**
 * An accessibility violation, said twice.
 *
 * The plain half leans on the one thing that makes these tickets confusing: the
 * screenshot usually looks fine, because the defect is in how the page is built
 * rather than in how it is drawn. Saying so is the difference between a reader
 * trusting the finding and a reader assuming lookout is wrong.
 */
function axeProse(df: DeterministicFinding): Prose {
  const m = df.meta ?? {};
  const rule = str(m.ruleId);
  const description = str(m.description);
  const impact = AXE_IMPACT[str(m.impact)] ?? "";
  const count = num(m.nodeCount);
  const targets = list(m.targets);
  const summaries = list(m.failureSummary);
  const helpUrl = str(m.helpUrl);

  const marked = targets.map((t) => `\`${t}\``);
  const nodes = axeNodes(m.nodes);
  // The elements as a person would point at them when the capture kept their
  // markup; the selectors, which only an agent can resolve, otherwise.
  const named = nodes.slice(0, 3).map((n) => elementPhrase(n.element));
  const where =
    count > 0
      ? `It fired on ${count} element${count === 1 ? "" : "s"} on this screen` +
        (named.length > 0 ? `: ${named.join(", ")}.` : marked.length > 0 ? `: ${marked.join(", ")}.` : ".")
      : "";
  const standard = standardOf(list(m.tags));
  // The sentence each check wrote, per element: the structured form of the
  // summary axe flattens, and what says exactly which part of the rule failed.
  const checked = nodes
    .filter((n) => n.checks.length > 0)
    .slice(0, 3)
    .map((n) => `What axe checked on ${elementPhrase(n.element)}: ${n.checks.map(sentence).join(" ")}`);

  // The message is "<rule id>: <axe's one-line help>". The id is already in the
  // ticket's metadata block and in `expected`, so the detail half prints the
  // help on its own rather than the id twice.
  const help = rule && df.message.startsWith(`${rule}: `) ? df.message.slice(rule.length + 2) : df.message;

  const plain = [
    description ? sentence(description) : sentence(help),
    "This is a rule about how the page is built rather than how it looks, so the",
    "screenshot may well look correct: the problem is what somebody navigating with",
    "a screen reader or a keyboard gets instead of what a sighted mouse user gets.",
    standard,
    impact,
  ]
    .filter(Boolean)
    .join(" ");

  const detail = [
    rule ? `The failing rule is \`${rule}\`: ${sentence(help)}` : sentence(help),
    where,
    // axe's summaries are multi-line and unpunctuated. Flattened and terminated
    // here, or they run straight into the reference link after them. The
    // per-check sentences replace them whenever the capture kept those.
    checked.length > 0
      ? checked.join(" ")
      : summaries.length > 0
        ? `axe's own account of what to change: ${summaries.map((s) => sentence(s.replace(/\s+/g, " "))).join(" ")}`
        : "",
    helpUrl ? `Reference: ${helpUrl}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    title: sentence(help).replace(/\.$/, "").slice(0, 160),
    problem: `${plain}\n\n${detail}`,
    expected: rule
      ? `The page satisfies the accessibility rule \`${rule}\`.${description ? ` ${sentence(description)}` : ""}`
      : "",
    observed:
      count > 0
        ? `${count} element${count === 1 ? "" : "s"} on this screen fail${count === 1 ? "s" : ""} it` +
          (marked.length > 0 ? ` (${marked.join(", ")}).` : ".")
        : "",
  };
}

/**
 * The rest of lookout's checks. Each already carries the measurement in its
 * message; what it lacks is the sentence saying why the measurement matters to
 * whoever is reading the ticket. The message is always kept, never replaced.
 */
const CONSEQUENCE: Partial<Record<DeterministicFinding["type"], string>> = {
  "console-error":
    "The application logged an error while this screen was being photographed. The screen may look " +
    "finished and still be missing whatever the failing code was meant to do, so treat this as a " +
    "defect that has not surfaced visually yet rather than as noise.",
  "page-error":
    "Code on this page threw and nothing caught it. Anything the failing script was responsible for " +
    "after that point did not happen, which is how a screen ends up looking complete while a control " +
    "on it silently does nothing.",
  "request-failed":
    "Something the page asked the network for never arrived. Whatever it was meant to fill in is " +
    "either missing from this screen or showing a fallback, and a reader has no way to tell which.",
  "horizontal-overflow":
    "Content runs off the side of the screen. On a narrow viewport that means a reader has to scroll " +
    "sideways to finish a line, or simply never sees the part that is off the edge.",
  "edge-clipped":
    "Content is drawn outside the box that is meant to hold it, and that box hides whatever leaves it. " +
    "Nothing scrolls to bring it back, so the part that is outside is not merely awkward to reach: it " +
    "is gone for anybody at this window size, however long they look.",
  "box-collision":
    "Two things that are not meant to be layered are occupying the same pixels, so whatever is " +
    "underneath is partly unreadable. Neither element is positioned as an overlay, which is what " +
    "separates this from a menu or a dialog doing its job.",
  "dead-interaction":
    "Something a person would click did nothing when it was clicked. To a user this reads as the " +
    "application being broken or frozen, with no feedback saying otherwise.",
  // The five below are problems with lookout's capture, or with how the
  // application answers it, rather than defects a user would see, and they
  // say so first: a reader who takes them for the application's fault goes
  // looking in the wrong place.
  "blank-shot":
    "This is a problem with lookout's capture rather than with the application: the screen was " +
    "photographed before it had drawn anything, so this picture is evidence of the capture timing, " +
    "not of the screen. Nothing else filed against it can be trusted until the screen is caught " +
    "after it has painted, which usually means a longer settle.",
  "capture-error":
    "This is a problem with lookout's capture rather than with the application: lookout could not " +
    "drive the page into the state it was asked to photograph (a state is a view reached by " +
    "interacting first, such as an opened menu), so that view has gone unjudged. That is a hole in " +
    "the evidence, not a clean result.",
  "scheme-mismatch":
    "Either the application ignores the colour scheme it is asked for (light or dark), or lookout's " +
    "way of asking did not reach it: the light and dark captures came back identical. Anyone using " +
    "the other scheme sees whatever this screenshot shows. The config's `scheme` setting says how " +
    "lookout asks.",
  "stale-frame":
    "This is a problem with lookout's capture rather than with the application: the screen was still " +
    "changing when it was photographed, so this picture is a moment in the middle of rendering rather " +
    "than the finished view.",
  "off-origin":
    "This is a problem with the capture rather than with the screen: the capture ended up on a " +
    "different application than the one under test, so this screenshot is not of the screen its " +
    "label claims, and every finding filed against it describes the wrong page. A sign-in redirect " +
    "is the usual cause.",
};

/** The five types that describe the capture rather than the application. */
const ABOUT_CAPTURE: ReadonlySet<DeterministicFinding["type"]> = new Set([
  "blank-shot",
  "capture-error",
  "scheme-mismatch",
  "stale-frame",
  "off-origin",
]);

/** The collision check's pairs, as much of them as a title needs. */
function pairs(v: unknown): { topText: string; underText: string }[] {
  if (!Array.isArray(v)) return [];
  return v.map((o) => {
    const r = (o ?? {}) as Record<string, unknown>;
    return { topText: str(r.topText), underText: str(r.underText) };
  });
}

/** The clip check's offender list, as much of it as a title needs. */
function offenders(v: unknown): { tag: string; text: string }[] {
  if (!Array.isArray(v)) return [];
  return v.map((o) => {
    const r = (o ?? {}) as Record<string, unknown>;
    return { tag: str(r.tag), text: str(r.text) };
  });
}

/** One line naming the defect, from the check's record rather than its message. */
function titleOf(df: DeterministicFinding): string {
  const m = df.meta ?? {};
  const head = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n)}…` : s);
  switch (df.type) {
    case "console-error":
      return `The page logged an error: ${head(df.message)}`;
    case "page-error":
      return `A script on the page threw: ${head(df.message)}`;
    case "request-failed":
      return `A request the page made failed: ${head(str(m.url) || df.message)}`;
    case "horizontal-overflow":
      return num(m.worst) > 0
        ? `Content runs ${num(m.worst)}px off the side of the screen${str(m.offender) ? ` (${str(m.offender)})` : ""}`
        : `The page scrolls ${num(m.delta)}px sideways at ${num(m.viewport)}px wide`;
    case "box-collision": {
      const p = pairs(m.pairs)[0];
      const over = p?.underText ? `"${head(p.underText, 30)}"` : "content beside it";
      const what = p?.topText ? `"${head(p.topText, 30)}"` : "Something";
      const many = num(m.collisions) > 1 ? ` (and ${num(m.collisions) - 1} more)` : "";
      return `${what} is drawn on top of ${over}${many}`;
    }
    case "edge-clipped": {
      // Named by what a person would look for, not by the selector: the first
      // offender's own text is the best label the page gave us.
      const first = offenders(m.offenders)[0];
      const what = first?.text ? `"${head(first.text, 40)}"` : first?.tag ? `A ${first.tag}` : "Content";
      const many = num(m.clipped) > 1 ? ` (and ${num(m.clipped) - 1} more)` : "";
      return str(m.clipper) === "viewport"
        ? `${what} is cut off at the edge of the screen with no way to scroll to it${many}`
        : `${what} is cut off by the area that holds it${many}`;
    }
    case "blank-shot":
      return "lookout photographed this screen before it had painted";
    case "capture-error":
      return str(m.state) ? `lookout could not open the "${str(m.state)}" state to photograph it` : "lookout could not photograph this state";
    case "scheme-mismatch":
      return "The light and dark captures came out the same";
    case "stale-frame":
      return "The screen was still changing when it was photographed";
    case "off-origin":
      return str(m.landed) ? `The capture landed on ${str(m.landed)} instead of the application` : "The capture landed on another application";
    case "dead-interaction":
      return str(m.name) ? `"${str(m.name)}" did nothing when clicked` : "A control did nothing when clicked";
    default:
      return head(df.message, 160);
  }
}

/** The fixed state and what this capture showed, per type; both from the record, never invented. */
function expectation(df: DeterministicFinding): { expected: string; observed: string } {
  const m = df.meta ?? {};
  const at = (s: string) => (s ? ` (${s})` : "");
  switch (df.type) {
    case "console-error":
      return {
        expected: "The page logs no errors while this screen renders.",
        observed: `${df.message}${at([str(m.url), num(m.line) ? `line ${num(m.line)}` : ""].filter(Boolean).join(" "))}${num(m.repeats) > 1 ? `, ${num(m.repeats)} times` : ""}`,
      };
    case "page-error":
      return { expected: "No script on this page throws uncaught.", observed: `${df.message}${at(str(m.stack).split("\n")[1]?.trim() ?? "")}` };
    case "request-failed":
      return { expected: "Every request this page makes succeeds.", observed: `${df.message}${at([str(m.method), str(m.resourceType)].filter(Boolean).join(" "))}` };
    case "horizontal-overflow":
      return {
        expected: "Nothing on the page extends past the viewport's edge, and the page does not scroll sideways.",
        observed: `${df.message}${at(str(m.offenderPath))}`,
      };
    case "box-collision":
      return {
        expected: "Nothing on this screen is drawn on top of anything else that is not an overlay.",
        observed: `${df.message}${at(str(m.offenderPath))}`,
      };
    case "edge-clipped":
      return {
        expected:
          str(m.clipper) === "viewport"
            ? "Every element is fully inside the screen at this width, or the page scrolls so a reader can reach it."
            : "Every element is fully inside the area that holds it, or that area scrolls so a reader can reach it.",
        observed: `${df.message}${at(str(m.offenderPath))}`,
      };
    case "blank-shot":
      return { expected: "The screen has painted before it is photographed.", observed: df.message };
    case "capture-error":
      return { expected: str(m.state) ? `The "${str(m.state)}" state can be reached and photographed.` : "Every state can be reached and photographed.", observed: df.message };
    case "scheme-mismatch":
      return { expected: "The dark and light captures differ: the application applies the scheme it is asked for.", observed: df.message };
    case "stale-frame":
      return { expected: "The screen has finished rendering before it is photographed.", observed: df.message };
    case "off-origin":
      return { expected: str(m.expected) ? `The capture stays on ${str(m.expected)}.` : "The capture stays on the application's own origin.", observed: df.message };
    case "dead-interaction":
      return { expected: str(m.name) ? `Clicking "${str(m.name)}" changes the page.` : "Every control lookout clicks changes the page.", observed: df.message };
    default:
      return { expected: "", observed: df.message };
  }
}

/**
 * The prose for one deterministic finding: what a person would notice, then
 * the check's own precise message. A type with nothing to add returns its
 * message unchanged rather than a padded version of it.
 */
export function explainDeterministic(df: DeterministicFinding): Prose {
  if (df.type === "axe-violation") return axeProse(df);
  const consequence = CONSEQUENCE[df.type];
  const trailer = ABOUT_CAPTURE.has(df.type) ? "What lookout recorded" : "What the check measured";
  return {
    title: titleOf(df),
    problem: consequence ? `${consequence}\n\n${trailer}: ${df.message}` : df.message,
    ...expectation(df),
  };
}
