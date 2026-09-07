/**
 * Which coding tools work an issue, and the two things a card can do to one.
 *
 * The choice is remembered per browser rather than per project, because it is a
 * preference about the reader: whoever is looking at this page opens issues in
 * the same editor whichever repository they are looking at.
 *
 * It is a selector rather than a switch. Naming two tools does not mean "either
 * will do", it means they work the issue together: the queue hands it to the
 * first, and the turn after a spent attempt goes to the next one, which opens
 * on a tree the first has already worked and the note it left. Turns, not a
 * committee, because they share one working tree and two agents in one tree is
 * the bug the queue's lease exists to prevent.
 */
import { esc, paint, slot } from "./dom.js";
import type { ToolChoice } from "../../report/handoff.js";

// Which coding tools a launch opens, in the order they take their turns.
// Remembered per browser, because it is a preference about the reader, not
// about the project.
let tools: ToolChoice[] = [];
let chosen: string[] = read();

/**
 * What was chosen last visit, in either spelling.
 *
 * The old key held one name. Reading it here rather than migrating on write
 * means a browser that has only ever seen the switch comes back with that tool
 * selected, instead of silently reset to the first one in the list.
 */
function read(): string[] {
  try {
    const many = localStorage.getItem("lookout.tools");
    if (many) {
      const parsed = JSON.parse(many) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string" && !!x);
    }
    const one = localStorage.getItem("lookout.tool");
    return one ? [one] : [];
  } catch {
    // A private window refuses storage, and a half-written value is not worth
    // failing over. The preference is then per visit.
    return [];
  }
}

/** The tools chosen, in the order they were offered, as objects. */
function picked(): ToolChoice[] {
  return tools.filter((t) => chosen.includes(t.key));
}

export function toolLabel(): string {
  const names = picked().map((t) => t.label);
  if (!names.length) return "your editor";
  if (names.length === 1) return names[0]!;
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1]!;
}
export function toolMark(): string {
  return picked().map((t) => t.mark).join("");
}
export function paintToggle(): void {
  const html = tools.map((t) =>
    '<button type="button" data-tool="' + esc(t.key) + '"'
    + ' aria-pressed="' + (chosen.includes(t.key) ? 'true' : 'false') + '"'
    + ' aria-label="' + esc(t.label) + '"'
    + (t.installed ? '' : ' data-missing="1"')
    + ' title="' + (t.installed ? 'work issues in ' + esc(t.label)
        + '; select both and they take turns on the same issue'
        : esc(t.bin) + ' is not on PATH; the command is shown so you can run it yourself')
    // The mark is markup, not text, so it is the one thing here not escaped:
    // it comes from lookout itself or from a file in the project.
    + '">' + t.mark + '</button>').join("");
  paint("toolToggle", chosen.join(",") + "|" + html, html);
}

export async function loadTools(): Promise<void> {
  try {
    tools = (await (await fetch("/api/tools")).json()) as ToolChoice[];
  } catch {
    tools = [];
  }
  // Anything this server has never heard of goes, and an empty selection falls
  // back to the first tool offered: a selector with nothing on can hand nothing
  // over, and a play button that refuses every press says nothing about why.
  chosen = chosen.filter((k) => tools.some((t) => t.key === k));
  if (!chosen.length && tools[0]) chosen = [tools[0].key];
  paintToggle();
}

export async function archive(issue: string, btn: HTMLButtonElement, archived: boolean): Promise<void> {
  const out = slot('[data-launched="' + CSS.escape(issue) + '"]');
  btn.disabled = true;
  try {
    const r = await fetch("/api/archive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issue: issue, archived: archived }),
    });
    const j = (await r.json()) as { error?: string };
    if (j.error) { out.textContent = j.error; btn.disabled = false; return; }
    // The board repaints from /api/status on its own tick, and the backlog was
    // just written, so the card will move on the next poll without this having
    // to reach into it.
    out.textContent = archived ? "filed away" : "back on the board";
  } catch (err) {
    out.textContent = String(err);
    btn.disabled = false;
  }
}

/**
 * Put an issue in the queue.
 *
 * It does not open anything. Pressing play on five cards used to open five
 * Terminal windows into one working tree; what the press means is "this one
 * next", and the server hands them over one at a time.
 */
export async function enqueue(issue: string, btn: HTMLButtonElement): Promise<void> {
  const out = slot('[data-launched="' + CSS.escape(issue) + '"]');
  btn.disabled = true;
  // The button is two SVGs, so it pulses rather than swapping its text:
  // writing textContent would delete the mark and never put it back.
  btn.classList.add("busy");
  try {
    const r = await fetch("/api/queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issue: issue, tools: chosen }),
    });
    const j = (await r.json()) as { error?: string; queue?: { issue: string }[] };
    // A refusal says why rather than queueing something the pump would drop on
    // its next tick, which from here looks like a press that did nothing.
    if (j.error) out.textContent = j.error;
    else {
      const at = (j.queue ?? []).findIndex((q) => q.issue === issue);
      out.textContent = at === 0 ? "handed to " + toolLabel() : "queued, " + nth(at + 1) + " in line";
    }
  } catch (err) {
    out.textContent = String(err);
  }
  btn.disabled = false;
  btn.classList.remove("busy");
}

/** Take one back out. The queue's X, and the way out of a head nobody ruled on. */
export async function unqueue(issue: string): Promise<void> {
  await fetch("/api/queue/remove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ issue: issue }),
  });
}

/** Ask lookout to rule on an issue now, because whoever was fixing it did not. */
export async function ruleNow(issue: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    await fetch("/api/rule", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issue: issue }),
    });
  } finally {
    // The board's own repaint puts the row back; re-enabling here covers a
    // refusal, which leaves the row exactly as it was.
    btn.disabled = false;
  }
}

/** 1st, 2nd, 3rd. Small enough to be worth not reaching for a formatter. */
function nth(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return n + "th";
  return n + (["th", "st", "nd", "rd"][n % 10] ?? "th");
}

/** The tools a launch will open, for whoever is asking. */
export function currentTools(): string[] {
  return [...chosen];
}

/**
 * Turn one on or off.
 *
 * The last one on cannot be turned off. An empty selector would leave the play
 * button with nobody to hand an issue to, and a control that quietly stops
 * working is worse than one that declines the press.
 */
export function toggleTool(next: string): void {
  const has = chosen.includes(next);
  if (has && chosen.length === 1) return;
  // Kept in the order the server offered them, so the turn order on the queue
  // is the order the buttons read left to right rather than the order they
  // happened to be clicked.
  chosen = has
    ? chosen.filter((k) => k !== next)
    : tools.filter((t) => t.key === next || chosen.includes(t.key)).map((t) => t.key);
  try {
    localStorage.setItem("lookout.tools", JSON.stringify(chosen));
  } catch {
    // A private window refuses storage; the choice still holds for this visit.
  }
  paintToggle();
}
