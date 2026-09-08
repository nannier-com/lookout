#!/usr/bin/env bun
// Test double for the codex CLI. Speaks the same envelope the real one does,
// which is deliberately NOT the Claude envelope: the point of having two
// doubles is that a bug in either adapter shows up as a difference between
// them rather than as one shared assumption nobody questions.
//
// What the real CLI does, and what this reproduces:
//   - the final message is written to the file named by `-o`, which is the
//     schema-free path the adapter actually trusts
//   - stdout is JSONL in the dotted vocabulary: thread.started, turn.started,
//     item.completed carrying an agent_message, turn.completed carrying usage
//   - usage is TOKENS, never dollars
//   - nothing in the stream ever reports opening an image, which is why the
//     adapter declares it cannot report reads
//
// MOCK_CODEX_MODE, which is deliberately NOT the same switch the Claude double
// reads: a dialogue runs both at once, and one variable meaning two things is
// how a test comes to drive a challenger as though it were a judge.
//
//   challenge  rule on every numbered finding in the prompt. MOCK_CHALLENGE
//              picks the verdict word (default "agree"); MOCK_CHALLENGE_ADD
//              adds one finding of its own in the lane the prompt names.
//   judge      file nothing and call every shot clean, so a Codex proposal can
//              be driven without a second contract to maintain here.
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] ?? "";
const outIndex = argv.indexOf("-o");
const outPath = outIndex >= 0 ? argv[outIndex + 1] : undefined;

function reply(): string {
  const mode = process.env.MOCK_CODEX_MODE ?? "challenge";
  if (mode === "judge") {
    const ids = [...prompt.matchAll(/shotId:\s*(\S+)/g)].map((m) => m[1]!);
    return JSON.stringify({ findings: [], cleanShotIds: [...new Set(ids)] });
  }
  // One verdict per "#N" the prompt numbered, which is how the real challenger
  // is told to answer: positionally, never by restating an identity.
  const indexes = [...prompt.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
  const verdict = process.env.MOCK_CHALLENGE ?? "agree";
  const verdicts = indexes.map((index) => ({
    index,
    verdict,
    ...(verdict === "agree" ? {} : { note: "the mock disagrees" }),
  }));
  const additions = [];
  if (process.env.MOCK_CHALLENGE_ADD) {
    const shotId = /shotId:\s*(\S+)/.exec(prompt)?.[1];
    const lane = /## This panel's lane\s*\n\s*\n?([a-z-]+)/m.exec(prompt)?.[1];
    if (shotId && lane) {
      additions.push({
        shotId,
        category: lane,
        attribute: "found-by-the-second-judge",
        region: "content",
        severity: "medium",
        title: "something the first judge missed",
        problem: "A plain sentence a person could follow. The precise statement follows it.",
        expected: "the thing to be right",
        observed: "the thing being wrong",
        confidence: "high",
        acceptance: ["it stops being wrong"],
      });
    }
  }
  return JSON.stringify({ verdicts, additions });
}

const text = "```json\n" + reply() + "\n```";
if (outPath) writeFileSync(outPath, text);

// The stream, in the shape the real CLI writes it. No image-open event appears
// here because none appears there; the adapter must not come to depend on one.
const lines = [
  { type: "thread.started", thread_id: "t1" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "i1", type: "agent_message", text } },
  { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } },
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\n");
