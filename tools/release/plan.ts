/** Release policy is checked against Changesets' parsed plan, before versioning. */
import { appendFile, readFile } from "node:fs/promises";

export function changesetCount(raw: unknown): number {
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid release plan");
  const plan = raw as Record<string, unknown>;
  if (!Array.isArray(plan.changesets) || !Array.isArray(plan.releases)) {
    throw new Error("Invalid release plan: expected changesets and releases");
  }
  for (const entry of plan.releases) {
    if (typeof entry !== "object" || entry === null) throw new Error("Invalid release entry");
    const release = entry as Record<string, unknown>;
    if (typeof release.name !== "string" || typeof release.type !== "string"
      || !["none", "patch", "minor", "major"].includes(release.type)) {
      throw new Error("Invalid release entry: expected a package name and version type");
    }
    if (release.type === "major") {
      throw new Error(`Major release of ${release.name} is blocked, including manual reruns. The owner must authorize a separate release-policy change.`);
    }
  }
  return plan.changesets.length;
}

if (import.meta.main) {
  const path = process.argv[2];
  const output = process.env.GITHUB_OUTPUT;
  if (!path || !output) throw new Error("Usage: plan.ts <release-plan.json>, with GITHUB_OUTPUT set");
  const count = changesetCount(JSON.parse(await readFile(path, "utf8")));
  await appendFile(output, `changesets=${count}\n`);
  console.log(`Found ${count} pending changeset(s); release policy passed.`);
}
