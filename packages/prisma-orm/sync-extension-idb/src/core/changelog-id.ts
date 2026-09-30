/**
 * Orders two changelog ids. The wire type is `string`; the server's ids are
 * UUID v7 (lowercase, fixed width, time-ordered), so plain string comparison
 * is the chronological order. Kept as one helper so the pull cursor and the
 * per-record staleness guard can never disagree about ordering.
 */
export function compareChangelogIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
