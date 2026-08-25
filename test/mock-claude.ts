#!/usr/bin/env bun
// Test double for the claude CLI. Speaks the same envelope: reads -p <prompt>
// from argv, replies on stdout with {"result": "..."} JSON. Behavior is driven
// by MOCK_MODE:
//   judge   emit one deliberate finding against the first shotId in the
//           prompt's manifest, everything else clean
//   verify  confirm index 0, refute every other index
//   prose   reply with prose + a trailing fenced json (parser must cope)
//   ask     plain-text answer
const argv = process.argv.slice(2);
const p = argv.indexOf("-p");
const promptText = p !== -1 ? argv[p + 1] ?? "" : "";
let mode = process.env.MOCK_MODE ?? "auto";
if (mode === "auto") {
  mode = promptText.includes("adversarial verifier") ? "verify" : "judge";
}

const shotIds = [...promptText.matchAll(/^- shotId: (.+)$/gm)].map((m) => m[1]!);

let result = "";
if (mode === "judge") {
  const [first, ...rest] = shotIds;
  result =
    "```json\n" +
    JSON.stringify({
      findings: first
        ? [
            {
              shotId: first,
              category: "contrast",
              attribute: "body-text",
              severity: "high",
              title: "Mock finding for plumbing tests",
              problem: "mock",
              expected: "mock",
              observed: "mock",
              confidence: "high",
            },
            {
              shotId: first,
              category: "not-a-category",
              attribute: "x",
              severity: "high",
              title: "Must be rejected by vocabulary enforcement",
              problem: "mock",
              expected: "mock",
              observed: "mock",
              confidence: "high",
            },
          ]
        : [],
      cleanShotIds: rest,
    }) +
    "\n```";
} else if (mode === "verify") {
  const indices = [...promptText.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
  result =
    "```json\n" +
    JSON.stringify({
      verdicts: indices.map((i) => ({
        index: i,
        verdict: i === 0 ? "confirmed" : "refuted",
        note: i === 0 ? "plainly visible" : "not visible in evidence",
      })),
    }) +
    "\n```";
} else if (mode === "prose") {
  result = "Sure! Here is my analysis.\n\n```json\n{\"findings\":[],\"cleanShotIds\":" +
    JSON.stringify(shotIds) + "}\n```";
} else {
  result = "Yes. The mock says so.\nConfidence: high";
}

console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, total_cost_usd: 0.0123 }));
