/**
 * `lookout targets`: resolve the project's targets and probe reachability,
 * and say which fold the project is judged in and why.
 */
import { assertTargetsAllowed, loadConfig } from "../config.js";
import { describeKind, detectProjectKind } from "../project-kind.js";
import { deviceDownReason, deviceLines, preflightDevices } from "../capture/native-preflight.js";
import { preflight, resolveTargets } from "../targets.js";
import { list, printJson, row, str, type Parsed } from "../util.js";

export async function targets(parsed: Parsed): Promise<number> {
  const resolved = await loadConfig({
    configPath: str(parsed.flags.config),
    url: str(parsed.flags.url),
    baseUrl: str(parsed.flags["base-url"]),
  });
  assertTargetsAllowed(resolved.config, !!parsed.flags["allow-remote"]);

  const selected = resolveTargets(resolved.config, list(parsed.flags.targets));
  const kind = await detectProjectKind(resolved.projectDir, resolved.config);
  // Each fold is probed for what it needs: the web fold's URLs, the device
  // fold's simulators and emulators with the app on them.
  const statuses = kind.web ? await preflight(selected) : [];
  const devices = await preflightDevices(resolved.config, kind.native);
  const ready = statuses.every((s) => s.up) && deviceDownReason(devices) === null;

  if (parsed.flags.json) {
    printJson({ project: resolved.project, configPath: resolved.configPath, targets: statuses, devices, fold: kind });
    return ready ? 0 : 1;
  }

  console.log(`project: ${resolved.project}`);
  console.log(`config:  ${resolved.configPath ?? "(zero-config via --url)"}`);
  // The fold first, because it decides what every run below photographs: a
  // React Native project that reads "web (desktop, tablet, phone)" here is
  // one whose native block is missing, and the evidence line says so.
  console.log(`fold:    ${describeKind(kind)}`);
  for (const line of kind.evidence) console.log(row("", line));
  console.log("");
  for (const s of statuses) {
    const state = s.up ? `up (${s.status})` : "DOWN";
    console.log(row(s.name, `${s.url}  ${s.routes} route(s)  ${state}`));
    if (!s.up && s.startHint) console.log(row("", `start it: ${s.startHint}`));
  }
  for (const line of deviceLines(devices)) console.log(row("device", line));
  const gap = deviceDownReason(devices);
  if (gap) console.log(gap);
  return ready ? 0 : 1;
}
