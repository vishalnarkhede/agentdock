/**
 * Finding a term in an open file, as the in-file search means it:
 * case-insensitive, non-overlapping, in reading order.
 *
 * This lives apart from the editor because it answers three questions that
 * have to agree — which occurrences to highlight, how many there are, and
 * which one you are on. When the count came from its own loop, the number
 * beside the search box moved while the file stayed where it was.
 */

/** A one-character term in a large file has more hits than anyone can use. */
export const MAX_MATCHES = 5000;

/** Where each occurrence of `term` starts, in order. */
export function matchOffsets(doc: string, term: string, limit = MAX_MATCHES): number[] {
  if (!term) return [];
  const needle = term.toLowerCase();
  const hay = doc.toLowerCase();
  const offsets: number[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1 && offsets.length < limit) {
    offsets.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return offsets;
}

/**
 * The first occurrence at or after `pos`, as an index into `offsets`. Null when
 * there is none, so a caller can decide whether that means the end or the
 * start of the file.
 */
export function firstMatchFrom(offsets: number[], pos: number): number | null {
  const at = offsets.findIndex((from) => from >= pos);
  return at === -1 ? null : at;
}

/** The next match along, wrapping at both ends the way a find box does. */
export function stepMatch(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return ((index + delta) % count + count) % count;
}
