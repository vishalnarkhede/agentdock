/** Pixels of finger travel that count as one line. */
export const TOUCH_LINE_PX = 16;

/** Lines a single gesture may ask for, matching the server's own ceiling. */
const MAX_LINES = 40;

/** Assumed row height when a wheel reports pixels and the real one is unknown. */
const ASSUMED_ROW_PX = 16;

const clamp = (lines: number) =>
  Math.sign(lines) * Math.min(MAX_LINES, Math.abs(Math.trunc(lines)));

/**
 * Lines of history one wheel event asks for.
 *
 * Positive goes back into the history, which is the opposite sign to `deltaY` —
 * a wheel pushed away from the reader is negative and means "show me what came
 * before". deltaMode says what the delta counts: 0 pixels, 1 lines, 2 pages.
 */
export function wheelScrollLines(
  deltaY: number,
  deltaMode: number,
  rows: number,
  rowHeightPx = ASSUMED_ROW_PX,
): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  const perUnit =
    deltaMode === 1 ? 1 : deltaMode === 2 ? Math.max(1, rows) : 1 / Math.max(1, rowHeightPx);
  const lines = -deltaY * perUnit;
  /* A notch that works out to less than a line still has to move: rounding it
     to zero would make a trackpad's small deltas scroll nothing at all. */
  return clamp(lines) || (lines > 0 ? 1 : -1);
}

/**
 * Lines of history a swipe asks for, and the travel left over.
 *
 * `travelPx` is positive when the finger moved up the screen, which on a phone
 * drags the content up to reveal what is newer — so it returns negative lines,
 * in the same "positive goes back" convention as the wheel.
 *
 * The remainder is handed back rather than dropped so a slow drag accumulates
 * into movement instead of being discarded as jitter over and over.
 */
export function touchScrollLines(travelPx: number): { lines: number; remainderPx: number } {
  if (!Number.isFinite(travelPx)) return { lines: 0, remainderPx: 0 };
  const lines = clamp(-travelPx / TOUCH_LINE_PX);
  if (lines === 0) return { lines: 0, remainderPx: travelPx };
  return { lines, remainderPx: travelPx % TOUCH_LINE_PX };
}
