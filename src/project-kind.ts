/**
 * Which fold a project is judged in: web viewports, devices, or both.
 *
 * A web application is photographed at desktop, tablet and phone; a native or
 * React Native application is photographed on iOS and Android devices. The
 * decision is read off the repository and the config, never asked of a model,
 * because an answer that changed between two runs over the same tree would be
 * worse than no answer at all.
 *
 * Two things are kept apart on purpose. What the repository SUGGESTS (a
 * `react-native` dependency, an `ios/` folder with an Xcode project) is
 * evidence, and `lookout targets` says it out loud. What a run can actually
 * DO on a device needs the config's `native` block (a deep-link scheme and a
 * bundle id), so only a configured platform joins the default walk. A
 * `platforms` list in the config is the project's own word and overrides both.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { allDeps, readJson, type PackageJson } from "./design/detect-tree.js";
import type { LookoutConfig, PlatformKind } from "./types.js";

export type NativePlatform = Exclude<PlatformKind, "web">;

export interface ProjectKind {
  /** The web fold: the three viewports are walked by default. */
  web: boolean;
  /** The device fold: these platforms are walked by default (each has a `native` block). */
  native: NativePlatform[];
  /** Platforms the repository looks built for that the config does not enable. */
  suggested: NativePlatform[];
  /** Why, in the words `lookout targets` prints. */
  evidence: string[];
  /** True when the config's `platforms` decided, and nothing was inferred. */
  declared: boolean;
}

/** Dependencies that mean the application also renders in a browser. */
const WEB_DEPS = ["react-native-web", "react-dom", "next", "nuxt", "vue", "svelte", "@angular/core", "astro", "solid-js"];

async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** The marks of an iOS or Android build in a checkout, read from disk. */
async function nativeMarks(projectDir: string): Promise<{ ios: string[]; android: string[] }> {
  const marks = { ios: [] as string[], android: [] as string[] };
  const top = await entries(projectDir);
  if (top.some((n) => n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace"))) marks.ios.push("an Xcode project at the root");
  if (top.includes("Package.swift")) marks.ios.push("Package.swift");
  const ios = await entries(join(projectDir, "ios"));
  if (ios.some((n) => n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace") || n === "Podfile")) marks.ios.push("ios/ holds an Xcode project");
  if (existsSync(join(projectDir, "build.gradle")) || existsSync(join(projectDir, "build.gradle.kts"))) marks.android.push("a Gradle build at the root");
  const android = await entries(join(projectDir, "android"));
  if (android.some((n) => n.startsWith("build.gradle") || n.startsWith("settings.gradle"))) marks.android.push("android/ holds a Gradle build");
  return marks;
}

export async function detectProjectKind(projectDir: string, config: LookoutConfig): Promise<ProjectKind> {
  if (config.platforms) {
    return {
      web: config.platforms.includes("web"),
      native: config.platforms.filter((p): p is NativePlatform => p !== "web"),
      suggested: [],
      evidence: [`platforms in the config: ${config.platforms.join(", ")}`],
      declared: true,
    };
  }
  const pkg = await readJson<PackageJson>(join(projectDir, "package.json"));
  const deps = allDeps(pkg);
  const marks = await nativeMarks(projectDir);
  const evidence: string[] = [];
  const looksNative = { ios: [...marks.ios], android: [...marks.android] };
  for (const dep of ["react-native", "expo"]) {
    if (dep in deps) {
      looksNative.ios.push(`${dep} in package.json`);
      looksNative.android.push(`${dep} in package.json`);
    }
  }
  const native: NativePlatform[] = [];
  const suggested: NativePlatform[] = [];
  for (const platform of ["ios", "android"] as const) {
    const configured = !!config.native?.[platform];
    const reasons = [...new Set(looksNative[platform])];
    if (configured) {
      native.push(platform);
      evidence.push(`${platform}: native.${platform} in the config` + (reasons.length ? ` (${reasons.join(", ")})` : ""));
    } else if (reasons.length > 0) {
      suggested.push(platform);
      evidence.push(`${platform}: ${reasons.join(", ")}, but no native.${platform} in the config`);
    }
  }
  const webDeps = WEB_DEPS.filter((d) => d in deps);
  const nativeAnywhere = native.length > 0 || suggested.length > 0;
  // Web by default unless the repository is built for devices and nothing
  // says it also renders in a browser. A native-looking project whose device
  // fold is not configured keeps the web fold: it is the one thing a run can
  // still do, and the evidence line says what is missing.
  const web = !nativeAnywhere || webDeps.length > 0 || native.length === 0;
  if (web) {
    evidence.push(
      nativeAnywhere
        ? webDeps.length > 0
          ? `web: ${webDeps.join(", ")} in package.json`
          : "web: the only fold this run can walk until a native block is configured"
        : "web: nothing here is built for a device",
    );
  } else {
    evidence.push("web: not walked; the repository is built for devices and names no browser renderer");
  }
  return { web, native, suggested, evidence, declared: false };
}

/** One line for a person: the fold and what it walks. */
export function describeKind(kind: ProjectKind): string {
  const folds: string[] = [];
  if (kind.web) folds.push("web (desktop, tablet, phone)");
  if (kind.native.length > 0) folds.push(`devices (${kind.native.join(", ")})`);
  return folds.length > 0 ? folds.join(" and ") : "nothing: no web fold and no native block";
}
