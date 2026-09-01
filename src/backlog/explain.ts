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
  critical: "axe rates this critical, meaning it stops somebody using assistive technology from getting at the content at all.",
  serious: "axe rates this serious, meaning it makes the affected content very hard to use with assistive technology.",
  moderate: "axe rates this moderate, meaning it frustrates somebody using assistive technology without stopping them outright.",
  minor: "axe rates this minor, meaning it is a nuisance rather than a barrier.",
};

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
  const where =
    count > 0
      ? `It fired on ${count} element${count === 1 ? "" : "s"} on this screen` +
        (marked.length > 0 ? `: ${marked.join(", ")}.` : ".")
      : "";

  // The message is "<rule id>: <axe's one-line help>". The id is already in the
  // ticket's metadata block and in `expected`, so the detail half prints the
  // help on its own rather than the id twice.
  const help = rule && df.message.startsWith(`${rule}: `) ? df.message.slice(rule.length + 2) : df.message;

  const plain = [
    description ? sentence(description) : sentence(help),
    "This is a rule about how the page is built rather than how it looks, so the",
    "screenshot may well look correct: the problem is what somebody navigating with",
    "a screen reader or a keyboard gets instead of what a sighted mouse user gets.",
    impact,
  ]
    .filter(Boolean)
    .join(" ");

  const detail = [
    rule ? `The failing rule is \`${rule}\`: ${sentence(help)}` : sentence(help),
    where,
    // axe's summaries are multi-line and unpunctuated. Flattened and terminated
    // here, or they run straight into the reference link after them.
    summaries.length > 0
      ? `axe's own account of what to change: ${summaries.map((s) => sentence(s.replace(/\s+/g, " "))).join(" ")}`
      : "",
    helpUrl ? `Reference: ${helpUrl}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
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
  "blank-shot":
    "The screen was photographed before it had drawn anything, so this capture is evidence of the " +
    "capture timing rather than of the application. Nothing else in this ticket can be trusted until " +
    "the screen is caught after it has painted.",
  "capture-error":
    "lookout could not reach the state it was asked to photograph, so this view has gone unjudged. " +
    "That is a hole in the evidence, not a clean result.",
  "scheme-mismatch":
    "The light and dark captures came back the same, which means the application never applied the " +
    "scheme it was asked for. Anyone using the other scheme sees whatever this screenshot shows.",
  "stale-frame":
    "The screen was still changing when it was photographed, so this image is a moment in the middle " +
    "of rendering rather than the finished view.",
  "off-origin":
    "The capture ended up on a different application than the one under test, so this screenshot is " +
    "not of the screen its label claims. Every finding filed against it is misattributed.",
  "dead-interaction":
    "Something a person would click did nothing when it was clicked. To a user this reads as the " +
    "application being broken or frozen, with no feedback saying otherwise.",
};

/**
 * The prose for one deterministic finding: what a person would notice, then
 * the check's own precise message. A type with nothing to add returns its
 * message unchanged rather than a padded version of it.
 */
export function explainDeterministic(df: DeterministicFinding): Prose {
  if (df.type === "axe-violation") return axeProse(df);
  const consequence = CONSEQUENCE[df.type];
  return {
    problem: consequence ? `${consequence}\n\nWhat the check measured: ${df.message}` : df.message,
    expected: "",
    observed: "",
  };
}
