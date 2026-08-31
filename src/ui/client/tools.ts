/**
 * Which coding tool an issue opens in, and the two things a card can do to one.
 *
 * The choice is remembered per browser rather than per project, because it is a
 * preference about the reader: whoever is looking at this page opens issues in
 * the same editor whichever repository they are looking at.
 */
import { esc, paint, slot } from "./dom.js";
import type { ToolChoice } from "../../report/handoff.js";

// Which coding tool a launch opens. Remembered per browser, because it is a
// preference about the reader, not about the project.
let tools: ToolChoice[] = [];
let tool: string | null = null;
try {
  tool = localStorage.getItem("lookout.tool");
} catch {
  // A private window refuses storage. The preference is then per visit.
  tool = null;
}
export function toolLabel(): string {
  const t = tools.find((x) => x.key === tool);
  return t ? t.label : "your editor";
}
export function toolMark(): string {
  const t = tools.find((x) => x.key === tool);
  return t ? t.mark : "";
}
export function paintToggle(): void {
  const html = tools.map((t) =>
    '<button type="button" data-tool="' + esc(t.key) + '"'
    + ' aria-pressed="' + (t.key === tool ? 'true' : 'false') + '"'
    + ' aria-label="' + esc(t.label) + '"'
    + (t.installed ? '' : ' data-missing="1"')
    + ' title="' + (t.installed ? 'open issues in ' + esc(t.label)
        : esc(t.bin) + ' is not on PATH; the command is shown so you can run it yourself')
    // The mark is markup, not text, so it is the one thing here not escaped:
    // it comes from lookout itself or from a file in the project.
    + '">' + t.mark + '</button>').join("");
  paint("toolToggle", tool + "|" + html, html);
}

export async function loadTools(): Promise<void> {
  try {
    tools = (await (await fetch("/api/tools")).json()) as ToolChoice[];
  } catch {
    tools = [];
  }
  if (!tools.some((t) => t.key === tool)) tool = tools[0]?.key ?? null;
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

export async function launch(issue: string, btn: HTMLButtonElement): Promise<void> {
  const out = slot('[data-launched="' + CSS.escape(issue) + '"]');
  btn.disabled = true;
  // The button is two SVGs now, so it pulses rather than swapping its text:
  // writing textContent would delete the mark and never put it back.
  btn.classList.add("busy");
  try {
    const r = await fetch("/api/launch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issue: issue, tool: tool }),
    });
    const j = (await r.json()) as {
      error?: string;
      launched?: boolean;
      toolLabel?: string;
      reason?: string;
      command?: string;
    };
    if (j.error) out.textContent = j.error;
    else if (j.launched) out.textContent = "opened in " + String(j.toolLabel);
    else {
      // Say why, and hand over the command rather than failing silently.
      out.innerHTML = esc(j.reason || "could not open a terminal") + " \u00b7 run: <code>"
        + esc(j.command) + "</code>";
    }
  } catch (err) {
    out.textContent = String(err);
  }
  btn.disabled = false;
  btn.classList.remove("busy");
}

/** The tool a launch will open, for whoever is asking. */
export function currentTool(): string | null {
  return tool;
}

/** Remember a different one. */
export function chooseTool(next: string): void {
  tool = next;
  try {
    localStorage.setItem("lookout.tool", tool);
  } catch {
    // A private window refuses storage; the choice still holds for this visit.
  }
  paintToggle();
}
