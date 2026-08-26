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
  /* An attached client runs on the alternate screen, so the browser's own
     scrollback is never populated and a wheel event would otherwise reach the
     agent as an arrow key — scrolling the prompt history instead of the view.
     Mouse mode hands the wheel to tmux, which scrolls its history in copy mode.

     status off keeps the UI capture-pane used to produce: tmux's status bar was
     never part of it. Both are session options, and session names are generated
     by AgentDock, so they are safe to pass as argv values. */
  for (const [option, value] of [
    ["status", "off"],
    ["mouse", "on"],
  ]) {
    if (run(["tmux", "set-option", "-t", session, option, value]).exitCode !== 0) return false;
  }
  return true;
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
  const current =
    options.cols && options.rows ? null : (options.measure ?? measurePtySession)(session);
  const cols = clampCols(options.cols ?? current?.cols ?? 80);
  const rows = clampRows(options.rows ?? current?.rows ?? 24);
  let outputCb: ((data: Uint8Array) => void) | null = null;
  let exitCb: ((reason: string) => void) | null = null;
  let closed = false;
  const pending: Uint8Array[] = [];

  const configure = options.configure ?? configurePtySession;
  if (!configure(session)) return null;

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
      try {
        terminal.resize(clampCols(nextCols), clampRows(nextRows));
      } catch {
        finish("terminal resize failed");
      }
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
      try {
        terminal.close();
      } catch {}
      try {
        process.kill();
      } catch {}
    },
  };
}
