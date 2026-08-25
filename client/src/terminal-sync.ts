/**
 * Keeping xterm's copy of the pane honest.
 *
 * Streaming makes the browser a mirror of tmux rather than a re-render of it:
 * bytes are applied once, and whatever they leave on screen stays there. That is
 * what makes it fast, and it is also the one weakness — a mirror can drift. A
 * dropped frame, a sequence xterm and tmux read differently, a resize landing
 * mid-redraw, and the screen keeps a wrong cell until something repaints it. The
 * user's own fix was to reload the page.
 *
 * So the server re-captures the pane during lulls and the client compares it
 * with what is actually rendered. Text only: the capture carries colour escapes
 * and xterm's buffer does not, and a mismatched colour is not worth a repaint.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]|\x1b[=>]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * Lines as they should be compared: no escapes, no trailing spaces, and no
 * blank lines at the end — tmux pads the pane to its full height and xterm
 * reports the same rows as empty strings, which is agreement, not difference.
 */
export function comparableRows(lines: string[]): string[] {
  const out = lines.map((l) => stripAnsi(l).replace(/\s+$/, ""));
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * True when the rendered screen no longer matches the pane.
 *
 * Both sides are trimmed to the shorter one first: the capture is the visible
 * pane, while the rendered rows can include scrollback above it, and a
 * disagreement about how much history there is is not a drift.
 */
export function paneDiffers(captureText: string, renderedRows: string[]): boolean {
  const pane = comparableRows(captureText.split("\n"));
  const shown = comparableRows(renderedRows);
  if (pane.length === 0) return false;
  /* Compare the pane against the same number of rows at the end of what is on
     screen — that is where the pane lives. */
  const tail = shown.slice(Math.max(0, shown.length - pane.length));
  if (tail.length !== pane.length) return true;
  for (let i = 0; i < pane.length; i++) {
    if (pane[i] !== tail[i]) return true;
  }
  return false;
}

/**
 * The escape sequence that repaints the visible screen in place.
 *
 * Deliberately not \x1bc: a full reset would clear the scrollback with it, and
 * losing the reader's history to fix a wrong cell is a bad trade. Home, erase
 * to the end of the screen, write the pane, then put the cursor where tmux says
 * it is — counted up from the bottom, for the reason in TerminalView.
 */
export function repaintSequence(
  paneText: string,
  paneHeight: number,
  cursorX: number,
  cursorY: number,
): string {
  const body = paneText.endsWith("\n") ? paneText.slice(0, -1) : paneText;
  const rowsUp = Math.max(0, paneHeight - 1 - cursorY);
  return (
    "\x1b[?25l" + // hide the cursor while painting
    "\x1b[H" + // home, without touching the scrollback
    "\x1b[J" + // erase from here to the end of the screen
    body +
    (rowsUp > 0 ? `\x1b[${rowsUp}A` : "") +
    `\x1b[${cursorX + 1}G` +
    "\x1b[?25h"
  );
}
