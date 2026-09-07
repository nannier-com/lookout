/**
 * The two things the page can throw away, and the asking that guards them.
 *
 * Its own module rather than two more functions in `tools.ts`, which is about
 * what a CARD can do to one issue. These are about the whole project, and they
 * are the only acts here that destroy rather than move something.
 *
 * Both go to the server. Emptying the rail looks like a job for
 * `clearTranscript` alone, and it is not: the transcript is a file with a
 * server-side cursor over it, handed to every page that connects, so a button
 * that only wiped the column would refill it on the next reload. The local
 * clear is still called, immediately, so the press is answered before the round
 * trip; the socket's reset frame is what makes it true for every other tab.
 */
import { confirmAction } from "./confirm.js";
import { say } from "./shell.js";
import { refresh } from "./state.js";
import { clearTranscript } from "./transcript.js";

/** POST with no body, and the server's answer, or null when it could not be reached. */
async function post(path: string): Promise<{ ok: boolean; why?: string; removed?: string[] } | null> {
  try {
    const r = await fetch(path, { method: "POST" });
    return (await r.json()) as { ok: boolean; why?: string; removed?: string[] };
  } catch {
    return null;
  }
}

/**
 * Empty the judge's transcript.
 *
 * The lighter of the two, and it still asks. A long run says a great deal that
 * is not written down anywhere a reader can get back to: the file this
 * truncates IS the record, so a mis-click here loses the same thing a mis-click
 * on the other one does, just less of it.
 */
export async function clearJudge(): Promise<void> {
  const go = await confirmAction({
    title: "Clear the judge's transcript?",
    body:
      "What the judge has said so far is discarded, here and on disk.\n\n"
      + "Findings, issues and screenshots are not touched.",
    confirmLabel: "Clear it",
  });
  if (!go) return;
  clearTranscript();
  const answer = await post("/api/narration/clear");
  if (answer === null) say("could not reach lookout to clear the transcript");
}

/**
 * Delete everything lookout has collected about this project.
 *
 * The prompt names what is unrecoverable rather than asking whether the reader
 * is sure. `.lookout/` is gitignored, so the issue folders and the frozen
 * before/after pixels inside them are not in any commit and no undo reaches
 * them. It also says what is kept, because "delete everything" and "forget
 * which project I am pointed at" are two acts and only one of them is this.
 */
export async function resetProject(): Promise<void> {
  const go = await confirmAction({
    title: "Delete everything lookout found here?",
    body:
      "The backlog, every issue folder with its before and after screenshots, "
      + "the capture workspace and the queue are deleted. None of it is in git, "
      + "so this cannot be undone.\n\n"
      + "Your settings are kept: lookout stays pointed at this project.",
    confirmLabel: "Delete everything",
    danger: true,
  });
  if (!go) return;
  const answer = await post("/api/reset");
  if (answer === null) {
    say("could not reach lookout to reset this project");
    return;
  }
  // Refused rather than failed: a run was in flight. Saying which is the
  // difference between a button that looks broken and one that is waiting.
  if (!answer.ok) {
    say(answer.why ?? "lookout would not reset this project");
    return;
  }
  clearTranscript();
  say(null);
  // The server pushed to every open tab already; this repaints from the answer
  // rather than waiting for that to arrive, which is what the rest of the page
  // does after an act the reader took.
  await refresh();
}
