/**
 * The `lookout.config.ts` lookout writes for a project that has none: the
 * template, and the dev command the project's lockfile implies for its
 * `startHint`. Split from config-write.ts, which owns writing, migrating and
 * ignoring; this file is the text itself.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_VIEWPORTS, DIRECTION_PRESETS, FORM_FACTORS } from "./types.js";

/** What a written config should point at, when lookout already knows. */
export interface ConfigSeed {
  /** Base URL from --url: the run that prompted the write. */
  url?: string;
  /** Dev command for `startHint`; `createConfig` derives it from the lockfile. */
  devCommand?: string;
}

/**
 * The dev command the project's lockfile implies. The lockfile is a fact
 * about which package manager the project uses; without one there is no
 * basis to name any, and npm is the ecosystem default, not a preference.
 */
export function devCommandFor(projectDir: string): string {
  if (["bun.lock", "bun.lockb"].some((f) => existsSync(join(projectDir, f)))) return "bun run dev";
  if (existsSync(join(projectDir, "pnpm-lock.yaml"))) return "pnpm dev";
  if (existsSync(join(projectDir, "yarn.lock"))) return "yarn dev";
  return "npm run dev";
}

export function configTemplate(seed: ConfigSeed = {}): string {
  const url = seed.url ?? "http://localhost:3000";
  const dev = seed.devCommand ?? "npm run dev";
  const startHint = seed.url
    ? `      // startHint: "${dev}",   // printed when this target is down\n`
    : `      startHint: "${dev}",\n`;
  const presets = FORM_FACTORS.map((f) => `${f} ${DEFAULT_VIEWPORTS[f].width}x${DEFAULT_VIEWPORTS[f].height}`).join(", ");
  return `import type { LookoutConfig } from "@nannier-com/lookout";

// lookout project config. Targets are the apps this repo renders; lookout
// captures them, judges them, and tracks findings in .lookout/backlog.json.
// lookout writes and maintains this file; it belongs at the project root and
// in git, while everything under .lookout/ is per-checkout state: the
// screenshots, the reports, the run log, and what went wrong with lookout
// itself while it was looking at this project.
// lookout never starts services: startHint is what it prints when one is down.
const config: LookoutConfig = {
  targets: [
    {
      name: "app",
      url: "${url}",
${startHint}      routes: ["/"],
    },
  ],

  // Form factors. Every run photographs each route at desktop, tablet and
  // phone (presets ${presets}, in CSS pixels at 2x); --viewports narrows a
  // run. Resize a preset by key; one you leave out keeps its default. There
  // is no adding or removing one.
  // viewports: { phone: { width: 375, height: 812 } },

  // How this app switches dark/light. "emulate" (default) uses the browser's
  // prefers-color-scheme; use "url-param" when the app reads a query param, or
  // "recipe" and export setScheme(page, scheme) for click choreography.
  // scheme: { mode: "emulate" },

  // Which schemes this app actually ships. Left out, both are photographed,
  // because a project that has not said cannot be assumed to have one. Say so
  // if it ships one: it halves the shots, and stops two identical captures
  // reading as a broken scheme switch.
  // schemes: ["dark"],

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

  // Navigation discovery: lookout enumerates each route's buttons, links, and
  // CTAs, an AI planner curates them, and check captures the resulting states.
  // WARNING: when enabled, lookout clicks everything by default, destructive
  // controls included; point targets at a disposable environment and list
  // anything untouchable in exclude.
  // navigation: {
  //   enabled: true,
  //   maxStatesPerRoute: 5,     // judged interaction states per route
  //   maxChecksPerRoute: 8,     // link verification clicks (no judging cost)
  //   exclude: ["Sign out"],    // selectors or accessible-name substrings
  // },

  // The screen map: "lookout map" reads the source for the application's
  // screens and how each is reached, and "check" then walks them one at a
  // time, screens found beyond the routes above included. Left out, a map is
  // walked whenever one exists; enabled: true also refreshes a stale one from
  // check (a source scan per run that needs it); false never walks one.
  // map: {
  //   enabled: true,
  //   maxScreens: 40,           // screens per target
  //   maxDepth: 4,              // levels below a configured route
  //   exclude: ["Sign out"],    // names or paths never mapped
  // },

  // A native or React Native app. Declaring a platform here puts the project
  // in the device fold: every run photographs its booted devices, one phone
  // and one tablet, each needing the app installed. lookout never boots a
  // simulator or installs an app; startHint is what it prints, in your words,
  // when a required device is missing.
  // native: {
  //   ios: { deepLinkScheme: "myapp", bundleId: "com.example.myapp", devices: ["phone"], startHint: "make ios-sim" },
  //   android: { deepLinkScheme: "myapp", bundleId: "com.example.myapp" },
  // },
  // Which fold to judge in, when the repository should not decide:
  // platforms: ["web"],

  // Project-specific judging rules, relative to this file.
  // rubric: "./rubric.md",
  // neverFile: ["the marketing hero intentionally overflows on phone"],

  // The design direction this project chose. The taste panel judges against it
  // instead of against defaults, and what it declares is never filed: a shipped
  // preset, your own DESIGN.md (the first 12 KB reach the judge, so keep the
  // rules above the token tables), or both. The presets that ship:
  //   ${DIRECTION_PRESETS.join(", ")}
  // direction: { preset: "minimalist-editorial" },
  // direction: { file: "./DESIGN.md" },

  // Knobs for the checks that lookout MEASURES, as opposed to the rules above,
  // which are written for the judges. A measurement is never suppressed by a
  // neverFile line, so anything that renders outside its box on purpose (a
  // carousel track, a marquee) is named here instead.
  // checks: { edgeClip: { ignore: [".carousel__track"] } },
};

export default config;
`;
}
