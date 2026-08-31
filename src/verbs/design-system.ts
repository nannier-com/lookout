/**
 * `lookout design-system`: what this project is built out of, and therefore
 * where a visual fix belongs.
 *
 * A defect is found on a screen and fixed in a component, and in any project
 * with a design system those two are rarely the same file. Worse, they are
 * often not even the same package: the screen is in `apps/web` and the button
 * is in `packages/ui`, and a fix session that does not know this will patch the
 * screen, leave the kit broken for every other consumer, and pass verification
 * while doing it.
 *
 * So lookout reads the repository and says what it found. This verb is the
 * inspection view of that; the same inventory is what puts a "where this
 * belongs" section into every issue document.
 *
 * `--audit` goes one step further and asks the conformance skill whether the
 * application is actually built out of the kit it has. That is the same reading
 * `check` does before it files, run on its own so somebody can look at an
 * unfamiliar repository and get an answer without capturing a single
 * screenshot. It costs model calls and it files nothing: `check` is the verb
 * that files.
 *
 * It reads. It never edits, and it never installs anything.
 */
import { relative } from "node:path";
import { loadConfig } from "../config.js";
import { detect, repoRootOf } from "../design/detect.js";
import { mergeHandRolls, readConformance } from "../design/conformance.js";
import { inventoryPath, saveInventory, type DesignInventory } from "../design/inventory.js";
import { resolveInventory } from "../design/resolve.js";
import { num, printJson, row, str, type Parsed } from "../util.js";
import type { ResolvedConfig } from "../types.js";

/** The human view. Paths are absolute where they are meant to be opened. */
export function renderInventory(resolved: ResolvedConfig, inv: DesignInventory): string {
  const l: string[] = [];
  const rel = (p: string) => relative(resolved.projectDir, p) || ".";

  if (inv.kits.length === 0) {
    l.push("no design system detected");
    l.push("");
    for (const n of inv.notes) l.push(`  ${n}`);
    return l.join("\n");
  }

  for (const [i, k] of inv.kits.entries()) {
    l.push(i === 0 ? `${k.name}  (primary)` : k.name);
    l.push(row("  found by", `${k.via}: ${k.evidence[0] ?? "-"}`, 18));
    l.push(
      row(
        "  fix goes in",
        k.editable
          ? "this repository"
          : "the upstream package (not this repo's to edit; fix the app's use of it)",
        18,
      ),
    );
    if (k.packageRoot) l.push(row("  package root", k.packageRoot, 18));
    for (const c of k.componentRoots) l.push(row("  components", c, 18));
    if (k.importPrefixes.length > 0) l.push(row("  imported as", k.importPrefixes.join(", "), 18));
    l.push(
      row(
        "  provides",
        k.exports.length > 0
          ? `${k.exports.length} component(s): ${k.exports.slice(0, 12).join(", ")}` +
            (k.exports.length > 12 ? ", ..." : "")
          : "not readable from here (an unreadable kit is unknown, not empty)",
        18,
      ),
    );
    if (k.docs) l.push(row("  docs", k.docs, 18));
    l.push("");
  }

  if (inv.tokens.length > 0) {
    l.push("tokens");
    for (const t of inv.tokens) {
      for (const f of t.files) l.push(row(`  ${t.name}`, f, 18));
    }
    l.push("");
  }

  if (inv.adoption) {
    const { fromKit, total } = inv.adoption;
    const pct = total > 0 ? Math.round((fromKit / total) * 100) : 0;
    l.push(`adoption: ${fromKit} of ${total} package import(s) in application source come from the kit (${pct}%)`);
    l.push("");
  }

  if (inv.handRolls.length > 0) {
    l.push(`hand-rolled look-alikes: ${inv.handRolls.length}`);
    for (const h of inv.handRolls.slice(0, 20)) {
      l.push(`  ${h.symbol ?? "component"} at ${rel(h.path)}:${h.line}`);
      l.push(
        `      built from <${h.elements.join(">, <")}>; ` +
          (h.candidate
            ? `the kit provides ${h.candidate}`
            : "the kit ships no equivalent, so this is a gap in it") +
          (h.foundBy === "skill" ? " (read by the conformance skill)" : ""),
      );
    }
    if (inv.handRolls.length > 20) l.push(`  ... and ${inv.handRolls.length - 20} more`);
    l.push("");
  }

  for (const n of inv.notes) l.push(n);
  return l.join("\n").trimEnd();
}

export async function designSystem(parsed: Parsed): Promise<number> {
  const resolved = await loadConfig({
    configPath: typeof parsed.flags.config === "string" ? parsed.flags.config : undefined,
    url: typeof parsed.flags.url === "string" ? parsed.flags.url : undefined,
  });

  const refresh = !!parsed.flags.refresh;
  const inv = refresh
    ? await (async () => {
        const fresh = await detect(resolved);
        await saveInventory(resolved, fresh);
        return resolveInventory(resolved, { refresh: false });
      })()
    : await resolveInventory(resolved);

  // The reading pass, on request. It layers over the inventory rather than
  // replacing it: the scan's suspicions are what the reader is handed, and what
  // comes back both adds to them and kills the wrong ones.
  //
  // A project with no kit has nothing to conform to, and the inventory already
  // says so in its own words, so the audit is skipped rather than reported as
  // zero files read.
  let audit: Awaited<ReturnType<typeof readConformance>> | null = null;
  if (parsed.flags.audit && inv.kits.length > 0) {
    audit = await readConformance(resolved, inv, await repoRootOf(resolved.projectDir), {
      model: str(parsed.flags.model),
      fileBudget: num(parsed.flags["max-conformance"]),
      cache: !parsed.flags["no-cache"],
    });
    inv.handRolls = mergeHandRolls(inv.handRolls, audit);
  }

  if (parsed.flags.json) {
    printJson({ ...inv, cachedAt: inventoryPath(resolved), ...(audit ? { audit } : {}) });
  } else {
    console.log(`\n${renderInventory(resolved, inv)}\n`);
    if (audit) {
      console.log(
        `conformance: ${audit.examined.length} of ${audit.considered} file(s) read ` +
          `(${audit.cached} cached)` +
          (audit.unread.length > 0 ? `, ${audit.unread.length} not read` : "") +
          `; ${audit.refuted.length} scanner suspicion(s) refuted; ~$${audit.costUsd.toFixed(4)}`,
      );
      for (const r of audit.refuted.slice(0, 10)) {
        console.log(`  not a hand-roll: ${r.symbol} in ${r.relPath} (${r.why})`);
      }
      console.log(
        "\nnothing here is filed; `lookout check` is the verb that files. The verdicts are " +
          "cached, so the next check files from them without re-reading.",
      );
    }
    console.log(`cached: ${inventoryPath(resolved)}`);
  }

  // An inventory is a fact about a repository, not a verdict on it: having no
  // design system is a legitimate answer, and exiting non-zero for it would
  // make a CI gate out of an observation. An audit IS a verdict, so it follows
  // the exit-code convention every other verb uses and reports 1 when it found
  // something.
  return audit && inv.handRolls.length > 0 ? 1 : 0;
}
