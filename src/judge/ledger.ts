/**
 * Judge cache, keyed by VIEW GROUP rather than by single shot.
 *
 * The rubric asks the judge to compare a view's dark/light pair and its
 * form-factor progression (BASE.md, judging procedure steps 2 and 3). A
 * per-shot cache breaks that: after a fix changes only the light shot, the
 * dark partner would be served from cache and never enter the batch, so the
 * judge would be asked for a comparison with one side missing and would
 * silently stop filing it. A `verify-fix` would then read that silence as
 * "fixed". Grouping the cache the way the rubric groups the judgement is what
 * makes a scoped re-check trustworthy.
 *
 * A group is one target + platform + route + state, across every form factor
 * and scheme. Its key is `<groupHash>@v<version>@<panel>@<promptHash>@<model>`,
 * where groupHash covers every member's pixel hash, so any member changing
 * re-judges the whole group for every panel, and promptHash covers one panel's
 * composed instructions, so amending a panel re-judges exactly the verdicts it
 * could have changed while the other panels' entries stand.
 *
 * Lives in .lookout/ledger.json (committed by projects that want cheap re-runs
 * across machines; harmless if ignored).
 */
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResolvedConfig, ShotRecord } from "../types.js";
import { lookoutDir } from "../config.js";
import { nowIso, sha256 } from "../util.js";
import type { VerifiedFinding } from "./verify.js";
import { atomicWriteJson } from "../state/atomic.js";
import { withStateLock } from "../state/lock.js";

export interface LedgerEntry {
  verdict: "clean" | "findings";
  /**
   * Post-verification findings, whole. `verified` is stored rather than assumed:
   * a `--no-verify` run records findings the refuter never saw, and medium and
   * low findings are never refuted at all, so a cache hit that stamped them
   * verified would report a check that did not happen.
   */
  findings?: VerifiedFinding[];
  /** Which panel's verdict this is, so a stale entry is readable when debugging. */
  panel: string;
  /** Member shot ids, same purpose. */
  shotIds: string[];
  judgedAt: string;
  runId: string;
  /**
   * The panel's reply, whole, as a file under the capture workspace
   * (relative to it). A pointer rather than the text: the ledger is committed
   * by projects that want cheap re-runs, and a transcript is page text.
   */
  reply?: string;
}

export interface Ledger {
  note: string;
  entries: Record<string, LedgerEntry>;
}

const NOTE =
  "lookout judge cache. Key = <viewGroupHash>@v<skillVersion>@<panel>@<promptHash>@<model>, where a " +
  "view group is one target+platform+route+state across every form factor and scheme, so comparative " +
  "findings never cache apart, and each judge panel holds its own entry per group. groupHash covers " +
  "each member's pixels plus its design hand-off image's bytes, and promptHash covers that panel's " +
  "judging, refuting and hand-off instructions as composed for the run. Editing a rubric, a neverFile " +
  "line, handoff.md, any judging skill, a design PNG, or the declared design direction (which reaches " +
  "only the taste panel's text) re-judges whatever it could have changed; " +
  "nothing has to be bumped by hand. The prior-findings block is excluded on purpose: it is a naming " +
  "aid, and adjudications are enforced at merge.";

export function ledgerPath(resolved: ResolvedConfig): string {
  return join(lookoutDir(resolved), "ledger.json");
}

/**
 * Hash of a whole view group: every member's pixel hash, sorted by shot id so
 * capture order cannot perturb it. One member changing changes the group hash.
 *
 * A member carrying a design reference contributes the hand-off image's hash
 * too: the judge compares the build against that image, so swapping the file
 * is a changed input even when the app's pixels held still. Conditional on
 * purpose, so groups without designs keep the hashes they have always had.
 *
 * The accessibility tree is the same argument for the two panels given it: a
 * cached anatomy or content verdict must not outlive the evidence it was formed
 * with. It is conditional twice over, on the panel asking and on the shot
 * having one, so a group hashes exactly as it always did for every panel that
 * is not shown a tree.
 */
export function groupHash(shots: ShotRecord[], opts: { aria?: boolean } = {}): string {
  const parts = shots
    .map((s) => {
      let part = `${s.id}@${s.hash}`;
      if (s.designHash) part += `@d:${s.designHash}`;
      // Only for the panels shown the tree, and only where a shot has one, so
      // every group whose key does not depend on it keeps the key it has.
      if (opts.aria && s.ariaHash) part += `@a:${s.ariaHash}`;
      return part;
    })
    .sort()
    .join("\n");
  return sha256(new TextEncoder().encode(parts));
}

/**
 * Everything except the pixels that can decide a verdict.
 *
 * The key used to carry the judge skill's version alone, which left three ways
 * for a cached verdict to outlive the rules that produced it. A project rubric
 * edited without bumping past the shipped skill's version changed the prompt and
 * not the key. `config.neverFile` never touched a version at all. And the
 * refuting skill's version was never in the key even though what the ledger
 * stores IS that skill's output, so amending the refuter left every stale
 * verdict standing.
 *
 * `promptHash` closes all three by covering the composed instruction text
 * itself. The version stays in the key because somebody reading ledger.json
 * should be able to see it without recomputing anything.
 */
export interface PanelIdentity {
  /** The judge panel whose verdicts this identity keys. */
  panel: string;
  version: number;
  /** Short sha256 over every instruction text that can change a verdict. */
  promptHash: string;
  model: string;
  /**
   * Whether this panel is shown the accessibility tree, and so whether the
   * tree belongs in its groups' hashes. Part of the identity rather than a
   * loose argument, because every call site that keys a verdict must agree
   * with the one that reads it back.
   */
  aria?: boolean;
}

export function panelIdentity(opts: {
  panel: string;
  version: number;
  /** The panel's composed rubric text, core and vocabulary and extensions. */
  panelText: string;
  refuteText: string;
  /**
   * handoff.md as composed for this run. Injected into the prompt only for
   * design-bearing batches, but hashed for every key: a split identity would
   * complicate the key for the rare event of a lookout release editing it,
   * and that release arguably owes a broad re-judge anyway.
   */
  handoffText: string;
  model: string;
  /**
   * The challenge instructions as composed for this run, or "" when one AI
   * judges. Hashed on the refuter's own argument: what a ledger entry stores
   * is partly this pass's output, so amending it has to invalidate the
   * verdicts it produced.
   */
  challengeText?: string;
  /**
   * Every AI that judged, as `<ai>:<model>`.
   *
   * A verdict two judges reached is not a verdict one reached, and serving one
   * for the other is exactly the stale-verdict failure this hash exists to
   * prevent. It goes into the HASH rather than the key because the key's five
   * "@"-separated segments are load-bearing: `pruneLedger` deletes anything
   * with a different count, so a sixth segment would make every existing entry
   * unreachable in the one way that also deletes it.
   *
   * SORTED, so the roster is a set rather than an order. Which AI proposed can
   * alternate between runs, and encoding that here would make every alternating
   * run a cache miss and hold cost at first-run prices forever. The order that
   * actually ran is recorded on the entry instead, where it is readable when
   * debugging without fragmenting the cache.
   */
  oracles?: readonly string[];
  /** Whether this panel is shown the accessibility tree. */
  aria?: boolean;
}): PanelIdentity {
  // NUL-separated: a prompt is markdown and never holds one, so no two texts
  // can slide across the boundary and hash the same as a different tuple.
  //
  // The prior-findings block ("ALREADY FILED") is excluded from this key on
  // purpose. It is a naming aid, not a verdict input: cache hits are
  // name-stable verbatim by construction, and by-design adjudications are
  // enforced at merge, never in the prompt, so keying on it would thrash the
  // whole cache on every adjudication for a benefit the cache already
  // provides more strongly than the prompt does.
  const roster = [...(opts.oracles ?? [])].sort().join("\u001f");
  const joined =
    `${opts.panelText}\u0000${opts.refuteText}\u0000${opts.handoffText}` +
    `\u0000${opts.challengeText ?? ""}\u0000${roster}`;
  return {
    panel: opts.panel,
    version: opts.version,
    promptHash: sha256(new TextEncoder().encode(joined)).slice(0, 12),
    model: opts.model,
    ...(opts.aria ? { aria: true as const } : {}),
  };
}

export function ledgerKey(hash: string, id: PanelIdentity): string {
  return `${hash}@v${id.version}@${id.panel}@${id.promptHash}@${id.model}`;
}

export async function loadLedger(resolved: ResolvedConfig): Promise<Ledger> {
  const p = ledgerPath(resolved);
  if (!existsSync(p)) return { note: NOTE, entries: {} };
  try {
    const parsed = JSON.parse(await readFile(p, "utf8")) as Ledger;
    return { note: NOTE, entries: parsed.entries ?? {} };
  } catch {
    return { note: NOTE, entries: {} };
  }
}

export async function saveLedger(resolved: ResolvedConfig, ledger: Ledger): Promise<void> {
  await withStateLock(resolved, "ledger", async () => saveLedgerLocked(resolved, ledger));
}

async function saveLedgerLocked(resolved: ResolvedConfig, ledger: Ledger): Promise<void> {
  const p = ledgerPath(resolved);
  await mkdir(dirname(p), { recursive: true });
  await atomicWriteJson(p, ledger);
}

export async function updateLedger<T>(
  resolved: ResolvedConfig,
  mutate: (ledger: Ledger) => T | Promise<T>,
): Promise<{ ledger: Ledger; result: T }> {
  return withStateLock(resolved, "ledger", async () => {
    const ledger = await loadLedger(resolved);
    const result = await mutate(ledger);
    await saveLedgerLocked(resolved, ledger);
    return { ledger, result };
  });
}

/**
 * Record one entry per judged view group. Findings are stored whole: on a
 * cache hit the group's findings come back together, which is what keeps a
 * comparative finding attached to the view it was made about.
 */
export function recordVerdicts(
  ledger: Ledger,
  runId: string,
  id: PanelIdentity,
  judged: { shots: ShotRecord[]; findings: VerifiedFinding[]; reply?: string }[],
): void {
  for (const { shots, findings, reply } of judged) {
    if (shots.length === 0) continue;
    ledger.entries[ledgerKey(groupHash(shots, { aria: id.aria }), id)] = {
      verdict: findings.length === 0 ? "clean" : "findings",
      ...(findings.length > 0 ? { findings } : {}),
      panel: id.panel,
      shotIds: shots.map((s) => s.id).sort(),
      judgedAt: nowIso(),
      runId,
      ...(reply ? { reply } : {}),
    };
  }
}


/**
 * Drop entries no current capture can ever hit again.
 *
 * A hit requires the key's exact group hash, so an entry whose hash matches
 * no group computable from the current report is unreachable: the pixels
 * moved, the route left the config, or the identity changed under it. The
 * committed ledger otherwise grows monotonically with every pixel change.
 * Entries for OTHER identities of a still-live hash are kept (alternating
 * --model keeps both caches), and the worst case of pruning wrongly is one
 * re-judge after a byte-identical revert, which is the failure this cache
 * prefers. Callers only run this on full-scope checks: a scoped run cannot
 * see every live group.
 */
export function pruneLedger(ledger: Ledger, liveGroupHashes: ReadonlySet<string>): number {
  let dropped = 0;
  for (const key of Object.keys(ledger.entries)) {
    const hash = key.slice(0, key.indexOf("@"));
    // A pre-panel key has four segments and can never be hit again; without
    // this, the committed ledger keeps dead entries for still-live hashes
    // forever.
    if (key.split("@").length !== 5 || !liveGroupHashes.has(hash)) {
      delete ledger.entries[key];
      dropped++;
    }
  }
  return dropped;
}
