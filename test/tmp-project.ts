// A throwaway project on disk, for tests that need a ResolvedConfig to load
// skills or a backlog against. Real directory, no config file executed.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "../src/types.js";

export function tmpProject(prefix = "lookout-test-", project = "proj"): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, ".lookout"), { recursive: true });
  return {
    config: { targets: [{ name: "app", url: "http://localhost:1" }] },
    configPath: join(dir, ".lookout", "config.ts"),
    projectDir: dir,
    project,
  };
}
