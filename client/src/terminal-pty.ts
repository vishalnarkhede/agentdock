export const TOUCH_WHEEL_STEP_PX = 16;

/**
 * Translate a vertical touch delta into SGR mouse-wheel reports understood by
 * tmux. Positive means the finger moved up (scroll toward newer output);
 * negative means it moved down (scroll toward older output).
 */
export function tmuxWheelSequence(deltaY: number, cols: number, rows: number): string {
  if (!Number.isFinite(deltaY) || Math.abs(deltaY) < TOUCH_WHEEL_STEP_PX) return "";
  const steps = Math.min(10, Math.floor(Math.abs(deltaY) / TOUCH_WHEEL_STEP_PX));
  const button = deltaY < 0 ? 64 : 65;
  const x = Math.max(1, Math.min(999, Math.round(cols / 2)));
  const y = Math.max(1, Math.min(999, Math.round(rows / 2)));
  return `\x1b[<${button};${x};${y}M`.repeat(steps);
}
