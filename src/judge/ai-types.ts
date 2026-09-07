/**
 * What lookout needs from an AI in order to judge with it, and nothing more.
 *
 * lookout used to have exactly one AI, and the shape of that one CLI was the
 * shape of every AI call it made: `allowedTools` held Claude Code's tool names,
 * the reply envelope was Claude Code's envelope, and the module that spoke to
 * it was called `claude.ts` because there was nothing else to call it. That was
 * honest while it was true. It stops being true the moment a second AI judges,
 * and the cost of leaving it is that every AI added later re-teaches the whole
 * codebase what a tool is called.
 *
 * So this file is the whole contract, and it is deliberately small. An adapter
 * says who it is, where its binary is, what it can be asked, and how to ask it
 * once. Everything else lookout already knows how to do.
 *
 * Two pieces of it are worth explaining, because both were bugs waiting to be
 * written:
 *
 *   capabilities   what a caller wants DONE, not what one vendor calls the tool
 *                  that does it. `["Read"]` is a Claude Code word; "read the
 *                  files I name" is the thing every judging path actually wants,
 *                  and it is the adapter's business to spell that the way its
 *                  own CLI spells it.
 *   reportsReads   whether this CLI can say which files it opened. lookout
 *                  demotes a shot called clean that was never opened, which is
 *                  a real safety check and depends on the CLI reporting its
 *                  tool calls. An adapter that cannot must SAY so, because the
 *                  alternative is lookout silently concluding that every shot
 *                  went unread and re-judging the same batch forever.
 */
import type { JudgeSay } from "./stream.js";
import type { CliFacts } from "./cli-probe.js";

/**
 * What a caller needs the AI to be able to do, in lookout's words.
 *
 * Read-only is the default everywhere for a reason: an oracle that can edit is
 * not an oracle. `edit-files` exists for exactly one caller, `self-heal`, which
 * is lookout repairing its own checkout, and even that one withholds a shell
 * because lookout runs the gates itself rather than trusting the reply.
 */
export type Capability = "read-files" | "search-files" | "edit-files";

/** One round trip, in terms no vendor owns. */
export interface JudgeInvocation {
  prompt: string;
  /**
   * Where the subprocess runs. Defaults to a scratch directory outside every
   * project (`judgeCwd`), which is what every judging path wants; `self-heal`
   * is the one caller that names its own, because it is editing that checkout.
   */
  cwd?: string;
  model: string;
  timeoutMs?: number;
  /**
   * What the subprocess may do, as capabilities rather than tool names.
   *
   * Defaults to reading the files the prompt names, which is what every
   * judging path wants.
   */
  capabilities?: Capability[];
  /**
   * Called as the model works, if the caller wants to watch.
   *
   * Supplying one also asks the CLI for its reply token by token rather than
   * turn by turn, where the CLI can, which is only worth the traffic when
   * somebody is reading it.
   */
  onSay?: (say: JudgeSay) => void;
}

/**
 * What came back.
 *
 * `spend` rather than a dollar figure, because what a CLI is willing to say
 * about what it cost is the CLI's business: one reports dollars and another
 * reports tokens, and lookout converting between them would mean carrying a
 * price list that is wrong the week a vendor changes it. Recording the number
 * in the unit it arrived in is the only honest option.
 */
export interface JudgeReply {
  text: string;
  spend?: Spend;
  /**
   * Every file the AI opened, in order, or an empty list from an adapter whose
   * `reportsReads` is false. Empty means "not reported", never "none opened",
   * which is why the flag exists rather than being inferred from this.
   */
  reads: string[];
}

/** What one call cost, in whatever unit the CLI was willing to state. */
export interface Spend {
  usd?: number;
  tokens?: number;
}

/** One AI lookout can judge with. */
export interface AiAdapter {
  /** The key the page, the settings file and the ledger know this AI by. */
  key: string;
  label: string;
  defaultModel: string;
  /**
   * Whether this CLI reports the files it opened. See the header: an adapter
   * that answers false turns OFF the unread-shot demotion rather than failing
   * it, and lookout says in the log that it did.
   */
  reportsReads: boolean;
  /** The binary to spawn, or null when this AI is not installed here. */
  bin(): Promise<string | null>;
  /** Its version, and the models this install offers. */
  probe(): Promise<CliFacts>;
  /** One round trip. */
  invoke(inv: JudgeInvocation): Promise<JudgeReply>;
}
