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
import { axeProse } from "./explain-axe.js";
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
  "focus-invisible":
    "A keyboard user cannot see where they are on this screen. lookout put keyboard focus on this " +
    "control and photographed it, and the picture is identical to the one at rest: nothing marks " +
    "the focused control at all. Anyone navigating by keyboard is then guessing which control " +
    "Enter will press.",
  "hover-silent":
    "This control gives no sign it can be used. lookout put the pointer on it and photographed it, " +
    "and the picture is identical to the one at rest: no colour change, no underline, no cursor " +
    "affordance the screen can show. A person hovering it learns nothing about whether it is live.",
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
    case "focus-invisible":
      return str(m.control)
        ? `Nothing shows when "${str(m.control)}" has keyboard focus`
        : "Nothing shows which control has keyboard focus";
    case "hover-silent":
      return str(m.control)
        ? `"${str(m.control)}" looks no different when the pointer is on it`
        : "A control looks no different when the pointer is on it";
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
    case "focus-invisible":
      return {
        expected: str(m.control)
          ? `"${str(m.control)}" is visibly marked when it has keyboard focus.`
          : "A control with keyboard focus is visibly marked.",
        observed: df.message,
      };
    case "hover-silent":
      return {
        expected: str(m.control)
          ? `"${str(m.control)}" responds visibly when the pointer is on it.`
          : "A control responds visibly when the pointer is on it.",
        observed: df.message,
      };
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
