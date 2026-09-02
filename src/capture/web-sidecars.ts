/**
 * What lookout writes beside a shot, while the page still shows what the PNG
 * shows: the rendering provenance and the accessibility tree.
 *
 * Split out of web-route.ts, which is the shape of the capture walk rather than
 * the shape of the files it drops. Both sidecars follow the same rule, and it
 * is the rule this module exists to state once: a sidecar that cannot be taken
 * costs the sidecar and never the shot. A screenshot lookout failed to describe
 * is still a screenshot the judges can rule on; a screenshot lookout failed to
 * take is a hole in the evidence.
 */
import type { Locator, Page } from "playwright";
import { buildAriaSidecar } from "./aria.js";
import { attachProvenance, buildSidecar, collectProvenanceInPage, selectorsOf } from "./provenance.js";
import { shotId, writeShotAria, writeShotSidecar, type ShotAxes } from "./store.js";
import type { DeterministicFinding, ResolvedConfig } from "../types.js";

/** How many elements the provenance walk visits before it stops. */
const MAX_PROVENANCE_ELEMENTS = 800;
/** A tree the page will not produce in ten seconds is one this shot goes without. */
const ARIA_TIMEOUT_MS = 10_000;

export interface SidecarRefs {
  /** Evidence-relative path of the provenance sidecar, when one was written. */
  provenance?: string;
  /** Evidence-relative path of the accessibility-tree sidecar, when one was written. */
  aria?: string;
  /** sha256 of the tree, which is a judge input and so a ledger input. */
  ariaHash?: string;
}

export async function writeSidecars(args: {
  resolved: ResolvedConfig;
  page: Page;
  element: Locator | null;
  elementSelector: string | null;
  axes: ShotAxes;
  runId: string;
  capturedAt: string;
  pngHash: string;
  image: { width: number; height: number };
  /** Findings whose selectors the provenance walk resolves against the live DOM. */
  findings: DeterministicFinding[];
  want: { provenance: boolean; aria: boolean };
  progress: (line: string) => void;
}): Promise<SidecarRefs> {
  const { resolved, page, element, elementSelector, axes, findings } = args;
  const id = shotId(axes);
  const refs: SidecarRefs = {};

  if (args.want.aria) {
    try {
      const yaml = await (element ?? page.locator("body")).ariaSnapshot({ timeout: ARIA_TIMEOUT_MS });
      const sidecar = buildAriaSidecar(
        yaml,
        { id, runId: args.runId, capturedAt: args.capturedAt, hash: args.pngHash },
        elementSelector,
      );
      // The path first, then the hash, and only if the write survived. The
      // hash is a ledger input for the two panels given the tree: a record
      // carrying ariaHash with no aria would cache a pixel-only verdict under
      // a key asserting the tree, and the same page would keep being served it.
      const written = (await writeShotAria(resolved, axes, sidecar)).rel;
      refs.aria = written;
      refs.ariaHash = sidecar.hash;
    } catch (e) {
      args.progress(`aria sidecar failed on ${id}: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  if (args.want.provenance) {
    try {
      const raw = await page.evaluate(collectProvenanceInPage, {
        rootSelector: element ? elementSelector : null,
        maxElements: MAX_PROVENANCE_ELEMENTS,
        // The deterministic findings' own selectors, joined against the live
        // DOM while it still shows what the PNG shows.
        resolve: findings.flatMap(selectorsOf),
      });
      const sidecar = buildSidecar(raw, {
        id,
        runId: args.runId,
        capturedAt: args.capturedAt,
        hash: args.pngHash,
        origin: element ? "element" : "document",
        image: args.image,
      });
      attachProvenance(findings, sidecar);
      refs.provenance = (await writeShotSidecar(resolved, axes, sidecar)).rel;
    } catch (e) {
      args.progress(`provenance failed on ${id}: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  return refs;
}
