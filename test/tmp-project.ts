// A throwaway project on disk, for tests that need a ResolvedConfig to load
// skills or a backlog against. Real directory, and a real config file beside
// it: never executed here, but a project IS a directory holding a lookout
// config, and code that asks the disk that question (the incident log, which
// refuses to create a `.lookout/` where lookout has no config) gets the same
// answer for a fixture as for a real checkout.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "../src/types.js";

export function tmpProject(prefix = "lookout-test-", project = "proj"): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, ".lookout"), { recursive: true });
  writeFileSync(
    join(dir, "lookout.config.ts"),
    'export default { targets: [{ name: "app", url: "http://localhost:1" }] };\n',
  );
  return {
    config: { targets: [{ name: "app", url: "http://localhost:1" }] },
    configPath: join(dir, "lookout.config.ts"),
    projectDir: dir,
    project,
  };
}
