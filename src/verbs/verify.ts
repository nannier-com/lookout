/**
 * `lookout verify --criteria <file|text>`: capture the scoped evidence, then
 * rule on each acceptance criterion strictly from what the screenshots show.
 * Exit 1 when any criterion fails (add --strict to also fail on
 * not-verifiable); the report lands in .lookout/evidence/verify-report.json.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { evidenceDir } from "../config.js";
import { loadReport } from "../capture/store.js";
import { verifyCriteria } from "../judge/criteria.js";
import { LookoutError } from "../types.js";
import { nowIso, printJson, str, type Parsed } from "../util.js";
import { runCapture } from "./capture.js";

export async function verify(parsed: Parsed): Promise<number> {
  const criteriaFlag = str(parsed.flags.criteria);
  if (!criteriaFlag) {
    throw new LookoutError(
      "verify needs --criteria <file or inline text>",
      'e.g. lookout verify --criteria ticket.md --targets app --routes /checkout',
    );
  }
  const criteriaText = existsSync(criteriaFlag)
    ? await readFile(criteriaFlag, "utf8")
    : criteriaFlag;
  if (criteriaText.trim().length < 8) {
    throw new LookoutError("the criteria text is empty or too short to mean anything");
  }

  const { resolved } = await runCapture(parsed);
  const report = await loadReport(resolved);
  if (!report) throw new LookoutError("capture produced no report");
  const latestRun = report.runs[report.runs.length - 1]!;
  const shots = report.shots.filter((s) => s.runId === latestRun.id);

  const evDir = evidenceDir(resolved);
  const model = str(parsed.flags.model) ?? "sonnet";
  const result = await verifyCriteria(resolved.project, criteriaText, shots, evDir, model);

  const failed = result.criteria.filter((c) => c.verdict === "fail");
  const unverifiable = result.criteria.filter((c) => c.verdict === "not-verifiable");
  const reportPath = join(evDir, "verify-report.json");
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        verifiedAt: nowIso(),
        model,
        criteriaSource: existsSync(criteriaFlag) ? criteriaFlag : "(inline)",
        shots: shots.map((s) => s.id),
        ...result,
        raw: undefined,
      },
      null,
      2,
    ),
  );

  if (parsed.flags.json) {
    printJson({ ...result, raw: undefined, reportPath });
  } else {
    console.log("");
    for (const c of result.criteria) {
      const mark = c.verdict === "pass" ? "PASS" : c.verdict === "fail" ? "FAIL" : "NOT VERIFIABLE";
      console.log(`  [${mark}] #${c.id} ${c.text}`);
      console.log(`      ${c.reasoning}`);
      if (c.evidence.length > 0) console.log(`      evidence: ${c.evidence.join(", ")}`);
      if (c.suggestion) console.log(`      suggestion: ${c.suggestion}`);
    }
    console.log(`\n${result.summary}`);
    console.log(`report: ${reportPath}`);
  }

  if (failed.length > 0) return 1;
  if (unverifiable.length > 0 && parsed.flags.strict) return 1;
  return 0;
}
