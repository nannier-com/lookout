/** A precise duration for a running clock. */
export function dur(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m" + String(seconds % 60).padStart(2, "0") + "s";
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours + "h" + String(minutes % 60).padStart(2, "0") + "m";
  return Math.floor(hours / 24) + "d";
}

/** A stable, coarse age for evidence and durable records. */
export function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours + "h ago";
  return Math.floor(hours / 24) + "d ago";
}

/** The one browser route that serves an issue's durable document. */
export function issueDocumentHref(id: string): string {
  return `/issue/${encodeURIComponent(id)}/Issue.md`;
}
