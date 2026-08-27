/**
 * A normal tmux client running inside a real PTY.
 *
 * tmux remains the session owner; this process is only a viewer. Unlike the
 * control-mode transport, tmux itself paints the initial screen and every
 * subsequent redraw into the PTY, so the browser receives one authoritative
 * terminal byte stream with no capture/repaint synchronization layer.
 */

export interface PtyTerminal {
  write(data: string | BufferSource): number;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface PtyProcess {
  terminal?: PtyTerminal;
  exited: Promise<number>;
  kill(): void;
}

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  onData: (data: Uint8Array) => void;
}

export type SpawnPty = (session: string, options: PtySpawnOptions) => PtyProcess;

export interface AttachPtyOptions {
  spawn?: SpawnPty;
  configure?: (session: string) => boolean;
  measure?: (session: string) => TerminalSize | null;
  run?: RunTmux;
  cols?: number;
  rows?: number;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface PtyClient {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onOutput(cb: (data: Uint8Array) => void): void;
  onExit(cb: (reason: string) => void): void;
  close(): void;
}

const clampCols = (cols: number) => Math.max(20, Math.min(500, Math.round(cols)));
const clampRows = (rows: number) => Math.max(5, Math.min(200, Math.round(rows)));

/** Lines one scroll request may move, so a flicked wheel cannot ask tmux to
    walk the whole history in a single command. */
const MAX_SCROLL_LINES = 40;

type RunTmux = (args: string[]) => { exitCode: number };
type ReadTmux = (args: string[]) => { exitCode: number; stdout: string };

/**
 * The size tmux is currently drawing the session at.
 *
 * Attaching sets the window size, so a client that has not measured its own
 * grid yet must attach at this size rather than at a guess: any other value
 * resizes the window under the agent and every other viewer, and tmux repaints
 * the whole screen to match.
 */
export function measurePtySession(
  session: string,
  read: ReadTmux = (args) => {
    const out = Bun.spawnSync(args);
    return { exitCode: out.exitCode, stdout: out.stdout.toString() };
  },
): TerminalSize | null {
  const out = read([
    "tmux",
    "display-message",
    "-p",
    "-t",
    session,
    "#{window_width} #{window_height}",
  ]);
  if (out.exitCode !== 0) return null;
  const [cols, rows] = out.stdout.trim().split(/\s+/).map(Number);
  if (!cols || !rows) return null;
  return { cols, rows };
}

export function configurePtySession(
  session: string,
  run: RunTmux = (args) => Bun.spawnSync(args),
): boolean {
  /* mouse off is what leaves selection to the browser. With it on, xterm has
     mouse reporting enabled and forwards the drag to tmux, which enters copy
     mode, highlights, and on release copies into a tmux buffer and cancels —
     so the selection vanished under the reader's hand and the text landed
     somewhere their clipboard cannot reach. It is set rather than left alone
     because a user's own tmux.conf may turn it on. Scrolling does not need it:
     the wheel is sent as an explicit scroll request instead.

     status off keeps the UI capture-pane used to produce: tmux's status bar was
     never part of it. Both are session options, and session names are generated
     by AgentDock, so they are safe to pass as argv values. */
  for (const [option, value] of [
    ["status", "off"],
    ["mouse", "off"],
  ]) {
    if (run(["tmux", "set-option", "-t", session, option, value]).exitCode !== 0) return false;
  }

  /* Whatever area of the browser's grid the window does not cover is filled by
     tmux with middle dots, which is what the grid of dots over the terminal
     was. A blank fill makes the same area read as an empty terminal instead.
     Optional because the option only exists from tmux 3.4, and an older tmux
     must still get a terminal. */
  run(["tmux", "set-option", "-t", session, "fill-character", " "]);
  return true;
}

/**
 * Hold the window at the size of the browser that is watching it.
 *
 * tmux sizes a window to whichever client was last active, so a second viewer
 * of the same session — the same session opened in iTerm, on a phone, in
 * another tab — resizes the window under this one. tmux then paints only the
 * part of the grid the window still covers and fills the rest, and a browser
 * that reflows those over-wide lines ends up with dots interleaved through the
 * output. Pinning the size makes this client's grid the truth for as long as it
 * is attached; releasePtyWindow gives the size back to tmux when it leaves.
 *
 * Other viewers see a clipped or blank-padded view rather than a wrong one:
 * tmux keeps its writes inside each client's own width.
 */
export function pinPtyWindow(
  session: string,
  size: TerminalSize,
  run: RunTmux = (args) => Bun.spawnSync(args),
): boolean {
  const args = ["tmux", "resize-window", "-t", session, "-x", String(size.cols), "-y", String(size.rows)];
  return run(args).exitCode === 0;
}

/** How often the pane is compared with itself while a redraw finishes. */
const SETTLE_POLL_MS = 60;
/** Samples in a row that must match for the redraw to count as finished. */
const SETTLE_SAMPLES = 2;
/** An agent that is mid-answer never stops changing the pane, so the wait for a
    redraw to finish is capped. */
const SETTLE_CAP_MS = 1200;

const paneText = (session: string, read: ReadTmux): string | null => {
  const out = read(["tmux", "capture-pane", "-p", "-t", session]);
  return out.exitCode === 0 ? out.stdout : null;
};

/**
 * Give the window its new size and let the agent finish redrawing before any
 * browser is attached to watch it.
 *
 * Resizing a window signals the program inside it, and an agent TUI answers by
 * rewriting its whole transcript: one size change on a Cursor session measured
 * 3.1MB of redraw over three seconds. Attached, that arrives as a screen that
 * fills and scrolls for seconds — the "starts at the top and scrolls to the
 * bottom" that opening a session looked like. Done here instead, before the PTY
 * exists, tmux absorbs the redraw into the pane and the attach that follows
 * paints the finished screen once.
 *
 * A no-op when the window already has the right size, which is the common case:
 * the window keeps whatever size the last browser pinned it to.
 */
export async function settlePtyWindow(
  session: string,
  size?: TerminalSize,
  options: {
    read?: ReadTmux;
    run?: RunTmux;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<boolean> {
  if (!size?.cols || !size?.rows) return false;
  const read =
    options.read ??
    ((args: string[]) => {
      const out = Bun.spawnSync(args);
      return { exitCode: out.exitCode, stdout: out.stdout.toString() };
    });
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? Date.now;

  const next = { cols: clampCols(size.cols), rows: clampRows(size.rows) };
  const current = measurePtySession(session, read);
  if (current && current.cols === next.cols && current.rows === next.rows) return false;

  pinPtyWindow(session, next, options.run);

  let previous = paneText(session, read);
  let stable = 0;
  const deadline = now() + SETTLE_CAP_MS;
  while (now() < deadline) {
    await sleep(SETTLE_POLL_MS);
    const text = paneText(session, read);
    stable = text !== null && text === previous ? stable + 1 : 0;
    previous = text;
    if (stable >= SETTLE_SAMPLES) break;
  }
  return true;
}

/**
 * Let tmux size the window from its clients again, and leave the browser's grid
 * behind as the size to use when there are none.
 *
 * Without the default, tmux falls back to the size the session was created at
 * as soon as the last client goes, so the window a browser had just sized to
 * its own grid snapped back the moment it closed the tab — and the next open
 * resized it again, making the agent redraw its transcript every single time.
 * With it, reopening a session finds the window already the right size and
 * nothing has to move.
 */
export function releasePtyWindow(
  session: string,
  size?: TerminalSize,
  run: RunTmux = (args) => Bun.spawnSync(args),
): boolean {
  // Before the option is dropped, so the fallback is already in place when tmux
  // recalculates the size.
  if (size) {
    run(["tmux", "set-option", "-t", session, "default-size", `${size.cols}x${size.rows}`]);
  }
  // Unset rather than set to a value: resize-window turned window-size manual
  // for this window only, so dropping it restores whatever the user configured
  // and another viewer can size the window again.
  return run(["tmux", "set-option", "-w", "-t", session, "-u", "window-size"]).exitCode === 0;
}

/**
 * Move the view through the pane's history.
 *
 * An attached client sits on the alternate screen, where the browser has no
 * scrollback of its own to scroll — the history lives in tmux. Asking tmux for
 * it directly is what lets mouse reporting stay off, so a drag remains a
 * browser selection.
 *
 * Positive lines go back into the history, negative return toward the prompt.
 */
export function scrollPtySession(
  session: string,
  lines: number,
  run: RunTmux = (args) => Bun.spawnSync(args),
): boolean {
  if (!Number.isFinite(lines)) return false;
  const count = Math.min(MAX_SCROLL_LINES, Math.abs(Math.round(lines)));
  if (count === 0) return false;

  const send = ["send-keys", "-X", "-N", String(count), "-t", session];
  /* -e so tmux drops out of copy mode on its own once the view is back at the
     bottom; without it the pane stays in a mode the next keystroke has to
     escape, which reads as a terminal that has stopped accepting input.

     Scrolling forward is only meaningful in copy mode, and entering it to do so
     would jump the view to the bottom — the opposite of the request — so that
     direction is sent alone and simply fails when there is nothing to return
     from. */
  const args =
    lines > 0
      ? ["tmux", "copy-mode", "-e", "-t", session, ";", ...send, "scroll-up"]
      : ["tmux", ...send, "scroll-down"];
  return run(args).exitCode === 0;
}

const spawnPty: SpawnPty = (session, options) => {
  return Bun.spawn(["tmux", "attach-session", "-t", `=${session}`], {
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
    terminal: {
      cols: options.cols,
      rows: options.rows,
      data(_terminal, data) {
        options.onData(data);
      },
    },
  }) as unknown as PtyProcess;
};

/**
 * Attach to an existing tmux session through a PTY.
 *
 * Output can arrive before the WebSocket callback is installed, so startup
 * chunks are retained and flushed exactly once when onOutput is registered.
 */
export function attachPty(
  session: string,
  options: AttachPtyOptions = {},
): PtyClient | null {
  /* Measured even when the client sent its grid: knowing what tmux is drawing
     is what says whether the window has to be moved at all. */
  const current = (options.measure ?? measurePtySession)(session);
  const cols = clampCols(options.cols ?? current?.cols ?? 80);
  const rows = clampRows(options.rows ?? current?.rows ?? 24);
  let outputCb: ((data: Uint8Array) => void) | null = null;
  let exitCb: ((reason: string) => void) | null = null;
  let closed = false;
  const pending: Uint8Array[] = [];

  const configure = options.configure ?? configurePtySession;
  if (!configure(session)) return null;

  const run = options.run;
  let pinned: TerminalSize = { cols, rows };
  /* Only when it would change something: settlePtyWindow has usually done this
     already, and asking tmux for a size a window already has is a redraw the
     agent would answer with another one. */
  if (!current || current.cols !== cols || current.rows !== rows) {
    pinPtyWindow(session, pinned, run);
  }

  const receive = (data: Uint8Array) => {
    if (closed || data.length === 0) return;
    if (outputCb) {
      outputCb(data);
      return;
    }
    // Bun may reuse the callback's buffer after it returns.
    pending.push(data.slice());
    if (pending.length > 500) pending.shift();
  };

  let process: PtyProcess;
  try {
    process = (options.spawn ?? spawnPty)(session, { cols, rows, onData: receive });
  } catch {
    return null;
  }

  const terminal = process.terminal;
  if (!terminal) {
    try {
      process.kill();
    } catch {}
    return null;
  }

  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    pending.length = 0;
    // Also on an exit nobody asked for: a pin outliving its client would leave
    // the session stuck at the size of a browser that has gone.
    releasePtyWindow(session, pinned, run);
    exitCb?.(reason);
  };

  process.exited
    .then((code) => finish(code === 0 ? "terminal detached" : `tmux exited (${code})`))
    .catch(() => finish("tmux attach failed"));

  return {
    write(data) {
      if (closed) return;
      try {
        terminal.write(data);
      } catch {
        finish("terminal write failed");
      }
    },
    resize(nextCols, nextRows) {
      if (closed || !Number.isFinite(nextCols) || !Number.isFinite(nextRows)) return;
      const next = { cols: clampCols(nextCols), rows: clampRows(nextRows) };
      /* Nothing to do when the grid has not moved, and the client reports the
         same grid often: once on connect, once per resize observation, once per
         drag frame. Both halves of a resize cost something — the ioctl signals
         the tmux client, and the pin is a tmux command — and a window that is
         set to a size it already has still makes tmux repaint the screen. */
      if (next.cols === pinned.cols && next.rows === pinned.rows) return;
      try {
        terminal.resize(next.cols, next.rows);
      } catch {
        finish("terminal resize failed");
        return;
      }
      // A pinned window no longer follows its client, so a browser that changed
      // shape has to move the pin with it.
      pinned = next;
      pinPtyWindow(session, next, run);
    },
    onOutput(cb) {
      outputCb = cb;
      for (const data of pending.splice(0)) cb(data);
    },
    onExit(cb) {
      exitCb = cb;
      if (closed) cb("terminal detached");
    },
    close() {
      if (closed) return;
      closed = true;
      pending.length = 0;
      releasePtyWindow(session, pinned, run);
      try {
        terminal.close();
      } catch {}
      try {
        process.kill();
      } catch {}
    },
  };
}
