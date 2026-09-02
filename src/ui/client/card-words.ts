// The words a card uses for lookout's own states, in one place: the status
// pill, the acceptance verdicts, and the line under a defect's title. The
// class names stay the raw values, since the stylesheet keys on them; only
// what a person reads is put into words.
import type { IssueStatus } from "../../report/board-types.js";

export function statusWords(status: IssueStatus): string {
  switch (status) {
    case "verifying": return "verifying now";
    case "still-open": return "still open";
    case "done": return "fix confirmed";
    case "archived": return "filed away";
    default: return status;
  }
}

/** The stylesheet's class for a verdict. */
export function verdictState(verdict: string | null): string {
  return verdict === "met" ? "met" : verdict === "unmet" ? "unmet"
    : verdict === "not-verifiable" ? "notverifiable" : "pending";
}

export function verdictMark(verdict: string | null): string {
  return verdict === "met" ? "\u2713" : verdict === "unmet" ? "\u2717"
    : verdict === "not-verifiable" ? "\u2013" : "";
}

/** The verdict as a person reads it beside the criterion. */
export function verdictWords(verdict: string | null): string {
  return verdict === "met" ? "met" : verdict === "unmet" ? "not met"
    : verdict === "not-verifiable" ? "not verifiable" : "not ruled";
}

/** What the token under a defect's title is: always said, never a bare label. */
export function ruleLine(category: string, attribute: string): string {
  return "rule " + category + "/" + attribute;
}
