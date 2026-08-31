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
//   conform read the first file in the prompt's list, file its first component
//           as a hand-roll of whatever the prompt says the kit provides, plus
//           one claim that must be rejected at ingestion
//   verify  confirm index 0, refute every other index
//   prose   reply with prose + a trailing fenced json (parser must cope)
//   ask     plain-text answer
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
// Tests that assert what reached the subprocess (a --model flag, a prompt
// shape) set MOCK_ARGV_FILE; every invocation appends its argv as one line.
if (process.env.MOCK_ARGV_FILE) {
  appendFileSync(process.env.MOCK_ARGV_FILE, JSON.stringify(argv) + "\n");
}
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
          : promptText.includes("placement advisor")
            ? "placement"
            : promptText.includes("conformance reader")
              ? "conform"
              : "judge";
}

const shotIds = [...promptText.matchAll(/^- shotId: (.+)$/gm)].map((m) => m[1]!);

// One flaky reply, then normal service: the retry paths are exercised by
// pointing MOCK_FLAKY_FILE at a path that does not exist yet. First
// invocation creates it and answers garbage; every later one behaves.
if (process.env.MOCK_FLAKY_FILE) {
  let first = false;
  try {
    readFileSync(process.env.MOCK_FLAKY_FILE);
  } catch {
    first = true;
    writeFileSync(process.env.MOCK_FLAKY_FILE, "flaked once\n");
  }
  if (first) {
    console.log(JSON.stringify({ result: "no json here, only vibes" }));
    process.exit(0);
  }
}

let result = "";
if (mode === "placement") {
  // MOCK_PLACEMENT overrides the whole verdict; the default names the kit path
  // the prompt's inventory block advertised, which is what a real reply does.
  const root = promptText.match(/^\s*components: (.+)$/m)?.[1] ?? "/unknown";
  result =
    process.env.MOCK_PLACEMENT ??
    "```json\n" +
      JSON.stringify({
        placement: "kit-component",
        primaryPath: `${root}/Button.tsx`,
        symbol: "Button",
        reason: "the component sets it for every caller",
        otherCallers: 3,
        blastRadius: "every Button in the product",
        alsoRead: [],
        notes: "",
      }) +
      "\n```";
} else if (mode === "conform") {
  // A real reply names files from the list and symbols read out of them, so the
  // mock does the same: anything else would exercise only the reject path.
  const files = [...promptText.matchAll(/^- (\/.+)$/gm)].map((m) => m[1]!);
  const provides = promptText.match(/^\s*provides: (.+)$/m)?.[1]?.split(", ") ?? [];
  const first = files[0];
  let symbol = "";
  if (first) {
    try {
      const text = readFileSync(first, "utf8");
      symbol = text.match(/(?:function|const|class)\s+([A-Z][A-Za-z0-9]*)/)?.[1] ?? "";
    } catch {
      symbol = "";
    }
  }
  result =
    process.env.MOCK_CONFORMANCE ??
    "```json\n" +
      JSON.stringify({
        findings:
          first && symbol
            ? [
                {
                  path: first,
                  symbol,
                  line: 1,
                  elements: ["div", "button"],
                  kitComponent: provides[0] ?? null,
                  what: "a pressable card",
                  why: "it is a control assembled from raw elements",
                  confidence: "high",
                },
                {
                  path: first,
                  symbol: "NeverDeclaredHere",
                  line: 999,
                  elements: ["div"],
                  kitComponent: null,
                  what: "a claim about a symbol that is not in the file",
                  why: "must be rejected at ingestion",
                  confidence: "high",
                },
              ]
            : [],
        // Every suspicion except the one just filed: a reply that files a
        // control and refutes it at once is incoherent, and the mock should
        // model a reader that is not.
        refuted: [...promptText.matchAll(/scanner suspects: ([A-Za-z0-9]+) /g)]
          .filter((m) => m[1] !== symbol)
          .map((m) => ({
            path: files.find((f) => promptText.includes(`- ${f}\n    scanner suspects: ${m[1]}`)) ?? first,
            symbol: m[1],
            why: "it is layout scaffolding, not a control",
          })),
        examined: files.slice(1),
      }) +
      "\n```";
} else if (mode === "heal") {
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
