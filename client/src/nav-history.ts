/**
 * Where you have been in the file explorer, so you can step back out of a
 * jump the way an IDE lets you.
 *
 * The model is the browser's: a list of places visited plus a cursor into it.
 * Going back moves the cursor rather than dropping the place, so forward can
 * return; opening something new from a point in the past drops what came
 * after, because that future no longer follows from where you are.
 */

export interface NavSpot {
  path: string;
  /** 1 when the file was opened whole rather than at a particular line. */
  line: number;
  /** Full-path opens live outside the session roots and reload differently. */
  external: boolean;
}

export interface NavHistory {
  spots: NavSpot[];
  /** The place on screen, or -1 before anything is open. */
  index: number;
}

export const EMPTY_HISTORY: NavHistory = { spots: [], index: -1 };

/** Enough to retrace an afternoon's reading, not a whole session. */
export const MAX_SPOTS = 50;

function isCurrent(history: NavHistory, spot: NavSpot): boolean {
  const current = history.spots[history.index];
  return (
    !!current &&
    current.path === spot.path &&
    current.line === spot.line &&
    current.external === spot.external
  );
}

/** Record arriving somewhere. Re-opening the current place changes nothing. */
export function visit(history: NavHistory, spot: NavSpot): NavHistory {
  if (isCurrent(history, spot)) return history;
  const spots = [...history.spots.slice(0, history.index + 1), spot];
  const dropped = Math.max(0, spots.length - MAX_SPOTS);
  return { spots: spots.slice(dropped), index: spots.length - dropped - 1 };
}

/**
 * Correct the current place to the line you actually ended up on, before
 * leaving it. Without this, back returns to the line a file was opened at
 * rather than the line you were reading when you jumped away.
 */
export function markLine(history: NavHistory, line: number): NavHistory {
  const current = history.spots[history.index];
  if (!current || !Number.isFinite(line) || line < 1 || current.line === line) return history;
  const spots = [...history.spots];
  spots[history.index] = { ...current, line };
  return { ...history, spots };
}

export function canGoBack(history: NavHistory): boolean {
  return history.index > 0;
}

export function canGoForward(history: NavHistory): boolean {
  return history.index < history.spots.length - 1;
}

export interface NavStep {
  history: NavHistory;
  spot: NavSpot;
}

/** The place before this one, or null at the start of the trail. */
export function back(history: NavHistory): NavStep | null {
  if (!canGoBack(history)) return null;
  const index = history.index - 1;
  return { history: { ...history, index }, spot: history.spots[index] };
}

/** The place after this one, or null when nothing was stepped back over. */
export function forward(history: NavHistory): NavStep | null {
  if (!canGoForward(history)) return null;
  const index = history.index + 1;
  return { history: { ...history, index }, spot: history.spots[index] };
}
