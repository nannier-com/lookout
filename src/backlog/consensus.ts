/**
 * What the judging AIs said to each other about one finding.
 *
 * Two AIs judging one screen produce one defect, not two, and everything here
 * exists to keep that true. So the first rule is what this is NOT: it is never
 * part of the fingerprint and never part of the cluster key. An identity that
 * carried who spoke would split one defect the moment a second AI agreed with
 * the first, which is the exact failure the dialogue is built to avoid.
 *
 * The second rule is that absence is not an answer. A finding with no
 * consensus was filed when one AI judged, or filed before two ever did, and a
 * reader must render that as unknown rather than substituting the AI that
 * happens to be configured today: stamping a vendor's name onto a verdict it
 * never gave is worse than saying nothing. That is the same reading
 * `SourceRef.foundBy` documents for its own absence, and the same one an
 * absent `region` gets in the merge.
 *
 * A dispute changes no status. It is a caveat on open work, not an
 * adjudication: `FindingStatus` stays closed at four, and "disputed" is
 * derived at render time by `isDisputed` rather than stored as a fifth. The
 * decision it records is the owner's, not lookout's, and letting one AI's
 * objection close another's finding would hand a single vendor a veto.
 */

/**
 * A judging AI, by the key its tool is known as ("claude-code", "codex").
 *
 * Never contains "@": these names can reach a ledger key, whose five
 * "@"-separated segments are load-bearing.
 */
export type OracleId = string;

/** One AI's objection, in its own words. */
export interface Dissent {
  oracle: OracleId;
  /** Why it says this is not a defect. Required: a dispute with no account is not one. */
  note: string;
}

/** What the AIs said about one finding. */
export interface FindingConsensus {
  /** The AI that filed it. */
  reportedBy: OracleId;
  /** AIs shown it that said the defect is real, in the order they were asked. */
  agreedBy?: OracleId[];
  /**
   * AIs shown it that said it is not a defect.
   *
   * The finding is still filed and still open. Nothing an AI saw is thrown
   * away because another disagreed; both accounts are kept and a person reads
   * them.
   */
  disputedBy?: Dissent[];
  /**
   * How many rounds the dialogue took. 1 is proposed and challenged once.
   *
   * With `disputedBy` non-empty at the cap, the two never agreed, which is a
   * fact worth showing rather than a state worth inventing.
   */
  rounds?: number;
}

/** Whether any AI shown this finding said it is not a defect. */
export function isDisputed(f: { consensus?: FindingConsensus }): boolean {
  return (f.consensus?.disputedBy?.length ?? 0) > 0;
}

/**
 * How many AIs vouch for this finding.
 *
 * 1 on a record nothing was ever asked about, which means "one account is
 * known" rather than "one AI vouched". Display only: nothing may branch on it,
 * for the same reason `confidence` decides nothing.
 */
export function corroboration(f: { consensus?: FindingConsensus }): number {
  return 1 + (f.consensus?.agreedBy?.length ?? 0);
}

/** Every AI that had an opinion, for a ticket that wants to name them. */
export function oraclesOf(c: FindingConsensus): OracleId[] {
  return [...new Set([c.reportedBy, ...(c.agreedBy ?? []), ...(c.disputedBy ?? []).map((d) => d.oracle)])];
}
