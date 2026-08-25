/**
 * `lookout targets`: resolve the project's targets and probe reachability.
 */
import { assertTargetsAllowed, loadConfig } from "../config.js";
import { preflight, resolveTargets } from "../targets.js";
import { list, printJson, row, str, type Parsed } from "../util.js";

export async function targets(parsed: Parsed): Promise<number> {
  const resolved = await loadConfig({
    configPath: str(parsed.flags.config),
    url: str(parsed.flags.url),
  });
  assertTargetsAllowed(resolved.config, !!parsed.flags["allow-remote"]);

  const selected = resolveTargets(resolved.config, list(parsed.flags.targets));
  const statuses = await preflight(selected);

  if (parsed.flags.json) {
    printJson({ project: resolved.project, configPath: resolved.configPath, targets: statuses });
    return statuses.every((s) => s.up) ? 0 : 1;
  }

  console.log(`project: ${resolved.project}`);
  console.log(`config:  ${resolved.configPath ?? "(zero-config via --url)"}\n`);
  for (const s of statuses) {
    const state = s.up ? `up (${s.status})` : "DOWN";
    console.log(row(s.name, `${s.url}  ${s.routes} route(s)  ${state}`));
    if (!s.up && s.startHint) console.log(row("", `start it: ${s.startHint}`));
  }
  return statuses.every((s) => s.up) ? 0 : 1;
}
