/**
 * Asking before an act that cannot be taken back.
 *
 * Both clear buttons go through here, so there is one dialog, one set of
 * keyboard behaviour and one place the wording is decided, rather than two
 * buttons that each grew their own idea of what a prompt is.
 *
 * A dialog, not `window.confirm`: the native one cannot say which of two very
 * different acts is being confirmed, cannot be styled to look destructive, and
 * blocks the page's own event loop while it is up, which would stall the socket
 * the rail is being written to. It follows the shot inspector's shape, being the
 * only other overlay here: hidden markup in the shell, focus moved in on open
 * and put back on close, Escape to dismiss.
 *
 * The promise is the point. A caller reads as the sentence it is:
 *
 *     if (!(await confirmAction({ ... }))) return;
 *
 * so the act and the asking are not two functions apart, and there is no way to
 * write the act without the question.
 */
import { el } from "./dom.js";

/** What the reader is being asked. */
export interface ConfirmAsk {
  /** The act, named as the button that opened it names it. */
  title: string;
  /**
   * What it costs.
   *
   * For a destructive act this has to name what is NOT recoverable. A prompt
   * that only asks "are you sure?" moves the decision without informing it.
   */
  body: string;
  /** The wording on the button that goes through with it. */
  confirmLabel: string;
  /** Whether to paint it as destructive. */
  danger?: boolean;
}

/**
 * The pending question's resolver, and who to give focus back to.
 *
 * Null when nothing is being asked, which is also how `closeConfirm` knows
 * whether it has a promise to settle: a stray Escape with no prompt up must not
 * resolve one that was never made.
 */
let settle: ((ok: boolean) => void) | null = null;
let opener: HTMLElement | null = null;

/** Whether the prompt is up, for whoever handles Escape first. */
export function confirmOpen(): boolean {
  return !el("confirm").hidden;
}

/**
 * Whether a click landed on the scrim rather than on the card.
 *
 * Clicking beside a dialog is the other thing everyone tries, and for a
 * question it means no: dismissing without answering is a refusal, never a yes.
 */
export function confirmBackdrop(e: Event): boolean {
  return e.target === el("confirm");
}

/** Put the question, and resolve with the answer. */
export function confirmAction(ask: ConfirmAsk): Promise<boolean> {
  // A second question while one is up would strand the first promise forever,
  // and a caller awaiting a press that can no longer happen never returns.
  // Answering it "no" is the truthful close: nobody agreed to anything.
  closeConfirm(false);
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  el("cfTitle").textContent = ask.title;
  el("cfBody").textContent = ask.body;
  const go = el("cfGo") as HTMLButtonElement;
  go.textContent = ask.confirmLabel;
  go.classList.toggle("danger", ask.danger === true);
  el("confirm").hidden = false;
  document.body.classList.add("confirmopen");
  // Focus lands on CANCEL, not on the act. A prompt that opens with the
  // destructive button focused turns a stray Enter into the thing it exists to
  // prevent, and the reader arrived here by pressing something already.
  (el("cfNo") as HTMLButtonElement).focus();
  return new Promise<boolean>((resolve) => {
    settle = resolve;
  });
}

/** Take the prompt down, answering it. */
export function closeConfirm(ok: boolean): void {
  if (!settle) return;
  const answer = settle;
  settle = null;
  el("confirm").hidden = true;
  document.body.classList.remove("confirmopen");
  // Focus goes home so a keyboard reader is not dropped at the top of the
  // document. The button that opened this may have been repainted away by the
  // poll in the meantime, hence the containment check.
  if (opener && document.contains(opener)) opener.focus();
  opener = null;
  answer(ok);
}
