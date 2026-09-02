/**
 * Reading what the CLI says while it is still saying it.
 *
 * `claude -p --output-format json` answers once, at the end, with everything.
 * That shape cost lookout two things at once. The page had nothing to show for
 * the minutes a panel takes, and the answer was released not when the model
 * finished but when the subprocess's stdout reached end-of-file, which is a
 * different moment: anything still holding the inherited pipe holds the reply
 * with it. Runs were observed sitting idle for the full ten-minute timeout with
 * the verdict already written and the child already gone.
 *
 * `stream-json` fixes both, because it makes the end of the answer something
 * lookout can SEE rather than something it has to wait for. The last line of
 * the stream is the result message; once that has been read there is nothing
 * further to wait for, whatever else is still holding the pipe open.
 *
 * This module is only the reading. It knows the envelope and nothing about
 * judging, which is why it can be given to the refuter, the healer and the
 * acceptance verifier unchanged.
 */

/** One thing the model did, as it did it. */
export interface JudgeSay {
  /** `text` is reply prose as it is written; `tool` is a tool call it made. */
  kind: "text" | "tool";
  text: string;
}

/** The CLI's terminal message: the same object `--output-format json` returns. */
export interface ResultLine {
  result?: string;
  total_cost_usd?: number;
  is_error?: boolean;
  subtype?: string;
}

/**
 * The stream, folded as it arrives.
 *
 * Chunks do not arrive on line boundaries, so a partial tail is carried to the
 * next push. A line that is not JSON is dropped rather than thrown on: the CLI
 * is entitled to print to stdout, and one stray line must not lose a verdict
 * that has already been paid for.
 */
export class ReplyStream {
  private tail = "";
  private everything = "";
  /** The terminal message, once the CLI has sent it. */
  result: ResultLine | null = null;
  /**
   * Every file the model asked the Read tool for, in order, whether or not
   * anybody is narrating. What a judge looked at is part of its verdict: a
   * shot it called clean without opening is not clean, and only this list
   * can say so.
   */
  readonly reads: string[] = [];

  constructor(private readonly onSay?: (say: JudgeSay) => void) {}

  push(chunk: string): void {
    this.everything += chunk;
    const lines = (this.tail + chunk).split("\n");
    this.tail = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  /** End of stream: whatever is left is a whole line or it is nothing. */
  end(): void {
    if (this.tail.trim()) this.line(this.tail);
    this.tail = "";
  }

  /** Everything stdout produced, which is what an unparseable reply is reported as. */
  raw(): string {
    return this.everything;
  }

  private line(line: string): void {
    const text = line.trim();
    if (!text.startsWith("{")) return;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (isResult(d)) {
      this.result = d as ResultLine;
      return;
    }
    if (d["type"] === "assistant") this.reads.push(...readsOf(d["message"]));
    if (!this.onSay) return;
    const say = narrate(d);
    if (say) this.onSay(say);
  }
}

/**
 * The terminal message.
 *
 * Named by its type where the CLI gives one, and otherwise recognised by
 * carrying the reply itself. No other line in the stream has a top-level
 * `result`, and an envelope that reports an error status without one is still
 * the last thing the run says.
 */
function isResult(d: Record<string, unknown>): boolean {
  return d["type"] === "result" || "result" in d || "is_error" in d;
}

/** What one non-terminal line is worth saying out loud, if anything. */
function narrate(d: Record<string, unknown>): JudgeSay | null {
  if (d["type"] === "stream_event") return fromDelta(d["event"]);
  if (d["type"] === "assistant") return fromTurn(d["message"]);
  return null;
}

/** Reply prose, as the model writes it. */
function fromDelta(event: unknown): JudgeSay | null {
  if (!isObject(event) || event["type"] !== "content_block_delta") return null;
  const delta = event["delta"];
  if (!isObject(delta) || delta["type"] !== "text_delta") return null;
  const text = delta["text"];
  return typeof text === "string" && text.length > 0 ? { kind: "text", text } : null;
}

/**
 * A tool call, as one line.
 *
 * Only the call is narrated, never its result: a judge's tool results are the
 * screenshots themselves, and a page is not the place to stream a megabyte of
 * base64 nobody can read.
 */
function fromTurn(message: unknown): JudgeSay | null {
  if (!isObject(message)) return null;
  const content = message["content"];
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (!isObject(part) || part["type"] !== "tool_use") continue;
    const name = typeof part["name"] === "string" ? part["name"] : "tool";
    return { kind: "tool", text: `${name} ${subject(part["input"])}`.trim() };
  }
  return null;
}

/** Every file a turn asked the Read tool for, in the order it asked. */
function readsOf(message: unknown): string[] {
  if (!isObject(message)) return [];
  const content = message["content"];
  if (!Array.isArray(content)) return [];
  const files: string[] = [];
  for (const part of content) {
    if (!isObject(part) || part["type"] !== "tool_use" || part["name"] !== "Read") continue;
    const input = part["input"];
    if (isObject(input) && typeof input["file_path"] === "string") files.push(input["file_path"]);
  }
  return files;
}

/** The one part of a tool's input worth showing: what it was pointed at. */
function subject(input: unknown): string {
  if (!isObject(input)) return "";
  for (const key of ["file_path", "path", "pattern", "command", "url"]) {
    const v = input[key];
    if (typeof v === "string") return v;
  }
  return "";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
