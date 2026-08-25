/**
 * `lookout init`: scaffold .lookout/config.ts in the current repo and ignore
 * the evidence directory. Refuses to overwrite an existing config.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LookoutError } from "../types.js";
import type { Parsed } from "../util.js";

const TEMPLATE = `import type { LookoutConfig } from "@nannier/lookout";

// lookout project config. Targets are the apps this repo renders; lookout
// captures them, judges them, and tracks findings in .lookout/backlog.json.
// lookout never starts services: startHint is what it prints when one is down.
const config: LookoutConfig = {
  targets: [
    {
      name: "app",
      url: "http://localhost:3000",
      startHint: "bun run dev",
      routes: ["/"],
    },
  ],

  // How this app switches dark/light. "emulate" (default) uses the browser's
  // prefers-color-scheme; use "url-param" when the app reads a query param, or
  // "recipe" and export setScheme(page, scheme) for click choreography.
  // scheme: { mode: "emulate" },

  // Named interaction recipes routes can opt into via states: ["name"].
  // states: {
  //   "menu-open": {
  //     prepare: async (page) => {
  //       await page.getByRole("button", { name: "Menu" }).click();
  //     },
  //     restore: async (page) => {
  //       await page.keyboard.press("Escape");
  //     },
  //   },
  // },

  // Project-specific judging rules, relative to this file.
  // rubric: "./rubric.md",
  // neverFile: ["the marketing hero intentionally overflows on phone"],
};

export default config;
`;

export async function init(_parsed: Parsed): Promise<number> {
  const cwd = process.cwd();
  const dir = join(cwd, ".lookout");
  const configPath = join(dir, "config.ts");
  if (existsSync(configPath)) {
    throw new LookoutError(`${configPath} already exists`, "edit it in place; init never overwrites");
  }
  await mkdir(dir, { recursive: true });
  await writeFile(configPath, TEMPLATE);

  // Evidence is bulky and regenerable; keep it out of the repo when one exists.
  const gitignore = join(cwd, ".gitignore");
  const ignoreLine = ".lookout/evidence/";
  if (existsSync(gitignore)) {
    const current = await readFile(gitignore, "utf8");
    if (!current.split("\n").some((l) => l.trim() === ignoreLine)) {
      const sep = current.endsWith("\n") ? "" : "\n";
      await appendFile(gitignore, `${sep}\n# lookout evidence (screenshots; regenerable)\n${ignoreLine}\n`);
      console.log(`added ${ignoreLine} to .gitignore`);
    }
  } else {
    console.log(`note: no .gitignore here; remember to ignore ${ignoreLine}`);
  }

  console.log(`wrote ${configPath}`);
  console.log("next: edit the target url/routes, then run `lookout targets` to verify");
  return 0;
}
