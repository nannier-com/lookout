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
//   navplan plan an overlay, a destructive click, and a navigation state from
//           the prompt's own affordance list, plus junk the parser must drop;
//           MOCK_NAVPLAN overrides the whole reply
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
  // The improve prompt QUOTES other prompts' vocabulary inside its signal
  // details ("the adversarial verifier had confirmed..."), so its own marker
  // is checked first; no other prompt contains it.
  mode = promptText.includes("improving one of lookout's skills")
    ? "improve"
    : promptText.includes("adversarial verifier")
      ? "verify"
      : promptText.includes("acceptance-criteria verifier")
        ? "criteria"
        : promptText.includes("editing lookout's own source")
          ? "heal"
          : promptText.includes("placement advisor")
            ? "placement"
            : promptText.includes("conformance reader")
              ? "conform"
              : promptText.includes("navigation planner")
                ? "navplan"
                : "judge";
}

const shotIds = [...promptText.matchAll(/^- shotId: (.+)$/gm)].map((m) => m[1]!);

// MOCK_FAIL_PANEL crashes only the judge call whose prompt carries the marker
// (a panel's own vocabulary bullet works), so one panel of a group can fail
// while its siblings answer.
if (process.env.MOCK_FAIL_PANEL && promptText.includes(process.env.MOCK_FAIL_PANEL)) {
  process.exit(1);
}

// The category a judge reply files under has to be one the prompt's own
// vocabulary section offers, or the lane rule rejects it: a panel prompt
// carries only its own bullets. Sliced to the section because the region
// vocabulary reuses the bullet shape (and the word "content").
function promptCategory(): string {
  const start = promptText.indexOf("## Category vocabulary");
  if (start === -1) return "contrast";
  const end = promptText.indexOf("\n## ", start + 22);
  const section = end === -1 ? promptText.slice(start) : promptText.slice(start, end);
  const listed = [...section.matchAll(/^- ([a-z0-9-]+):/gm)].map((m) => m[1]!);
  if (listed.length === 0) return "contrast";
  return listed.includes("contrast") ? "contrast" : listed[0]!;
}

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
} else if (mode === "navplan") {
  // A real reply plans from the prompt's own affordance list, so the mock
  // does the same: first button becomes an overlay state, that same button is
  // re-planned as destructive (ordering, not blocking, is the contract), the
  // first link becomes a navigation state (the parser reroutes it to checks
  // itself when its destination is configured), and one entry is deliberate
  // junk the parser must drop.
  const affs = [...promptText.matchAll(/^- (a\d+) \[([a-z-]+)\] "([^"]*)"(?: \([^)]*\))?(?: -> (\S+))?$/gm)]
    .map((m) => ({ id: m[1]!, role: m[2]!, name: m[3]!, href: m[4] ?? null }));
  const kebab = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "state";
  const button = affs.find((a) => a.role !== "link");
  const link = affs.find((a) => a.role === "link" && a.href);
  const states = [];
  if (button) {
    states.push({ affordance: button.id, name: kebab(button.name) + "-open", outcome: "overlay",
      risk: "safe", why: "mock overlay" });
    states.push({ affordance: button.id, name: "danger-click", outcome: "in-page-change",
      risk: "destructive", why: "mock destructive entry, must stay executable" });
  }
  if (link) {
    states.push({ affordance: link.id, name: "goto-" + kebab(link.name), outcome: "navigation",
      risk: "safe", why: "mock navigation" });
  }
  states.push({ affordance: "a999", name: "Bad Name!!", outcome: "overlay", risk: "safe",
    why: "must be dropped by the parser" });
  result = process.env.MOCK_NAVPLAN
    ? "```json\n" + process.env.MOCK_NAVPLAN + "\n```"
    : "```json\n" + JSON.stringify({ states, checks: [], skipped: [] }) + "\n```";
} else if (mode === "heal") {
  const file = process.env.MOCK_HEAL_FILE;
  if (file) writeFileSync(file, "// written by the mock healer\n");
  // MOCK_HEAL_GARBAGE: edits are made, then the reply breaks the contract.
  // The forfeit path (revert, incident, exit 1) is only reachable this way.
  if (process.env.MOCK_HEAL_GARBAGE) {
    console.log(JSON.stringify({ result: "I fixed it, trust me, no json today" }));
    process.exit(0);
  }
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
      skill: process.env.MOCK_IMPROVE_SKILL ?? "judge-core",
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
              category: process.env.MOCK_JUDGE_CATEGORY ?? promptCategory(),
              attribute: "body-text",
              region: process.env.MOCK_JUDGE_REGION ?? "content",
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
  // MOCK_VERIFY_FAIL crashes only the refuter, so the judge-succeeds,
  // refuter-fails path is reachable with one binary serving both roles.
  if (process.env.MOCK_VERIFY_FAIL) process.exit(1);
  const indices = [...promptText.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
  // MOCK_VERIFY overrides the whole verdicts object, for tests that need a
  // refutation the default confirm-index-0 shape cannot express.
  result = process.env.MOCK_VERIFY
    ? "```json\n" + process.env.MOCK_VERIFY + "\n```"
    :
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
  // MOCK_CRITERIA overrides the whole reply, for tests that need verdicts the
  // default one-of-each shape cannot express (an all-pass run, no-fail runs).
  result = process.env.MOCK_CRITERIA
    ? "```json\n" + process.env.MOCK_CRITERIA + "\n```"
    :
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

// The real CLI streams when asked to, so the double does too: a caller that
// passed --include-partial-messages is one whose narration path is under test,
// and a double that answered only at the end could not exercise it.
if (argv.includes("--include-partial-messages")) {
  const say = (o: unknown) => console.log(JSON.stringify(o));
  say({ type: "system", subtype: "init", cwd: process.cwd() });
  say({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Read", input: { file_path: shotIds[0] ?? "shot.png" } }] },
  });
  // In thirds, so a consumer that has to reassemble deltas is actually made to.
  const size = Math.max(1, Math.ceil(result.length / 3));
  for (let i = 0; i < result.length; i += size) {
    say({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: result.slice(i, i + size) } } });
  }
}
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, total_cost_usd: 0.0123 }));
