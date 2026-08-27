#!/usr/bin/env bun
// Test double for the claude CLI. Speaks the same envelope: reads -p <prompt>
// from argv, replies on stdout with {"result": "..."} JSON. Behavior is driven
// by MOCK_MODE:
//   judge   emit one deliberate finding against the first shotId in the
//           prompt's manifest, everything else clean. MOCK_JUDGE_CATEGORY
//           chooses the category, which is what the regression gate matches on
//   improve emit a skill amendment; MOCK_AMENDMENT overrides the body
//   heal    edit a file in cwd (MOCK_HEAL_FILE) and report the fix, so the
//           gates and the revert path can be exercised end to end
//   verify  confirm index 0, refute every other index
//   prose   reply with prose + a trailing fenced json (parser must cope)
//   ask     plain-text answer
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const p = argv.indexOf("-p");
const promptText = p !== -1 ? argv[p + 1] ?? "" : "";
let mode = process.env.MOCK_MODE ?? "auto";
if (mode === "auto") {
  mode = promptText.includes("adversarial verifier")
    ? "verify"
    : promptText.includes("acceptance-criteria verifier")
      ? "criteria"
      : promptText.includes("improving one of lookout's skills")
        ? "improve"
        : promptText.includes("editing lookout's own source")
          ? "heal"
          : "judge";
}

const shotIds = [...promptText.matchAll(/^- shotId: (.+)$/gm)].map((m) => m[1]!);

let result = "";
if (mode === "heal") {
  const file = process.env.MOCK_HEAL_FILE;
  if (file) writeFileSync(file, "// written by the mock healer\n");
  result =
    "```json\n" +
    JSON.stringify({
      incident: "judge reply was not parseable JSON after a retry",
      summary: "Retry the judge once more before giving up on the reply.",
      cause: "One retry is not enough when the model opens with prose.",
      files: [file ?? ""],
      test: "covered by the mock",
      changed: true,
    }) +
    "\n```";
} else if (mode === "improve") {
  result =
    "```json\n" +
    JSON.stringify({
      skill: "visual-judge",
      summary: "Stop filing the deliberate light-only surface as a scheme defect.",
      amendment: process.env.MOCK_AMENDMENT ?? "- The marketing hero is deliberately light in both schemes.",
      evidence: ["app.root.color-scheme.by-design"],
      newSkill: null,
    }) +
    "\n```";
} else if (mode === "judge") {
  const [first, ...rest] = shotIds;
  result =
    "```json\n" +
    JSON.stringify({
      findings: first
        ? [
            {
              shotId: first,
              category: process.env.MOCK_JUDGE_CATEGORY ?? "contrast",
              attribute: "body-text",
              severity: "high",
              title: "Mock finding for plumbing tests",
              problem: "mock",
              expected: "mock",
              observed: "mock",
              acceptance: ["Body text is legible against the card background."],
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
              acceptance: ["Body text is legible against the card background."],
              confidence: "high",
            },
          ]
        : [],
      // MOCK_SKIP_LAST drops a shot from both lists, which is a judge quietly
      // failing to rule on it: the case the output contract exists to catch.
      cleanShotIds: process.env.MOCK_SKIP_LAST ? rest.slice(0, -1) : rest,
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
} else if (mode === "criteria") {
  result =
    "```json\n" +
    JSON.stringify({
      criteria: [
        { id: 1, text: "The settings page shows a Security section", verdict: "pass",
          reasoning: "visible", evidence: shotIds.slice(0, 1) },
        { id: 2, text: "Subscription copy is legible", verdict: "fail",
          reasoning: "low contrast", evidence: shotIds.slice(0, 1),
          suggestion: "darken the text color" },
        { id: 3, text: "Saving emits an audit log entry", verdict: "not-verifiable",
          reasoning: "backend behavior; needs log capture", evidence: [] },
      ],
      summary: "1 pass, 1 fail, 1 not verifiable",
    }) +
    "\n```";
} else if (mode === "prose") {
  result = "Sure! Here is my analysis.\n\n```json\n{\"findings\":[],\"cleanShotIds\":" +
    JSON.stringify(shotIds) + "}\n```";
} else {
  result = "Yes. The mock says so.\nConfidence: high";
}

console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, total_cost_usd: 0.0123 }));
