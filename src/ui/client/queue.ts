/**
 * The queue, under the judge, down the right of the page.
 *
 * The list is the server's; this draws it and joins each row to the board by
 * id, because the board is in the same payload and already carries every
 * issue's title and status. Sending each issue twice would be sending the same
 * thing twice.
 *
 * The head is the row anything is happening to. It says what it is waiting for
 * and, once handed over, how long it has been waiting: what lookout waits on is
 * its own ruling, and an agent that fixed the defect and stopped without asking
 * for one leaves this row sitting there. "Handed off 14m ago" is what turns
 * that from silence into something to act on, and the two buttons beside it are
 * the acting.
 */
import { el, esc, paint } from "./dom.js";
import type { BoardEntry } from "../../report/board-types.js";
import type { QueueItem } from "../queue.js";
import type { StatusPayload } from "../payload.js";

/** What the board's own renderer asks, to draw a card's button as queued. */
let queued = new Set<string>();

export function isQueued(id: string): boolean {
  return queued.has(id);
}

/**
 * What this row is waiting for, in words.
 *
 * Every branch names the thing that would move it along, because a queue whose
 * rows say only "waiting" is a queue nobody can unstick. The one case with no
 * words here is the handed-off head, whose wait is an age rather than a state
 * and is painted by the shared ticker.
 */
function stateOf(q: QueueItem, entry: BoardEntry | undefined, head: boolean): string | null {
  if (q.failedAt) return q.lastReason ?? "the handoff did not open";
  if (!head) return "waiting its turn";
  if (!q.handedOffAt) return "next up";
  if (entry?.status === "verifying") return "lookout is ruling on it now";
  return null;
}

function row(q: QueueItem, entry: BoardEntry | undefined, i: number): string {
  const head = i === 0;
  const cls = ["qrow", head ? "head" : "", q.failedAt ? "failed" : ""].filter(Boolean).join(" ");
  const title = entry ? entry.title || entry.label : "no longer on the board";
  const words = stateOf(q, entry, head);
  // Painted by the shared ticker rather than baked in, so a row that sits here
  // for an hour keeps saying something true without anything repainting it.
  const state = words !== null
    ? esc(words)
    : '<span data-age data-since="' + esc(q.handedOffAt ?? "") + '" data-prefix="handed off ">'
      + "—</span> · waiting for lookout to rule";
  // Only on the head, and only once it has actually been handed over: ruling on
  // an issue nobody has looked at yet spends an attempt for nothing.
  const rule = head && q.handedOffAt && !q.failedAt
    ? '<button type="button" class="qrule" data-rule="' + esc(q.issue) + '"'
      + ' title="Ask lookout to rule on this issue now, when whoever was fixing it did not"'
      + ' aria-label="Ask lookout to rule on issue ' + esc(q.issue) + ' now">Rule</button>'
    : "";
  return '<div class="' + cls + '" role="listitem">'
    + '<span class="qn" aria-hidden="true">' + (head ? "•" : String(i + 1)) + "</span>"
    + '<span class="qbody"><span class="qid">' + esc(q.issue) + "</span> "
    + '<span class="qtitle">' + esc(title) + "</span>"
    + '<span class="qstate">' + state + "</span></span>"
    + rule
    + '<button type="button" class="qx" data-unqueue="' + esc(q.issue) + '"'
    + ' title="Remove this issue from the queue"'
    + ' aria-label="Remove issue ' + esc(q.issue) + ' from the queue">×</button>'
    + "</div>";
}

export function paintQueue(d: StatusPayload): void {
  const items = d.status.queue ?? [];
  queued = new Set(items.map((q) => q.issue));

  const byId = new Map(d.status.board.map((b) => [b.id, b]));
  el("queueCount").textContent = items.length ? String(items.length) : "";
  // The dot says "there is work lined up here" from a folded column too, which
  // is the one place the list itself cannot be read.
  el("stream").classList.toggle("queued", items.length > 0);

  // The signature is the queue plus whatever of the board a row draws: a title
  // that changed, or a head that has started being ruled on, both have to
  // repaint, and neither of them is in the queue record.
  const sig = JSON.stringify(items.map((q) => {
    const b = byId.get(q.issue);
    return [q.issue, q.handedOffAt, q.failedAt, q.lastReason, b?.title, b?.status];
  }));
  paint("queueList", sig, items.map((q, i) => row(q, byId.get(q.issue), i)).join(""));
}
