/**
 * tmux control mode — a byte stream instead of five screenshots a second.
 *
 * The snapshot path spawns two tmux processes per frame (`display-message` for
 * the cursor, then `capture-pane` for the visible pane plus 200 lines of
 * scrollback), serializes the whole pane to JSON, compares it to the last one,
 * and ships the entire pane on any change. At a 200ms poll that is ten process
 * spawns a second per open terminal and a full-screen repaint per frame — about
 * five frames a second, whatever the renderer can do.
 *
 * `tmux -C attach` is the interface built for this. One long-lived child per
 * session emits `%output %<pane> <bytes>` as the bytes are produced, so the
 * socket carries deltas — usually tens of bytes — and xterm repaints only the
 * cells that changed. It is what iTerm2's tmux integration is built on.
 *
 * Commands here are fire-and-forget. tmux wraps command replies in
 * `%begin`/`%end` blocks, but it emits one such block on attach that belongs to
 * no command, so correlating replies by arrival order silently pairs every
 * reply with the wrong command. Nothing on this path needs a reply — the one
 * value we do need, the pane id, is read with a plain one-off spawn.
 */

export type ControlEvent =
  | { kind: "output"; pane: string; data: Uint8Array }
  | { kind: "exit"; reason: string }
  | { kind: "notification"; name: string; args: string }
  | { kind: "block"; name: "begin" | "end" | "error" }
  | { kind: "line"; text: string };

const ENCODER = new TextEncoder();

/**
 * Turns one `%output` payload back into bytes.
 *
 * tmux escapes anything unprintable as a three-digit octal `\ooo` and a
 * backslash as `\\`; printable UTF-8 passes through untouched, so the literal
 * runs have to be encoded rather than copied byte-for-byte.
 */
export function unescapeOutput(payload: string): Uint8Array {
  const out: number[] = [];
  let literalStart = 0;

  const flush = (end: number) => {
    if (end > literalStart) {
      const bytes = ENCODER.encode(payload.slice(literalStart, end));
      for (const b of bytes) out.push(b);
    }
  };

  for (let i = 0; i < payload.length; i++) {
    if (payload[i] !== "\\") continue;
    const next = payload[i + 1];
    if (next === "\\") {
      flush(i);
      out.push(0x5c);
      i += 1;
      literalStart = i + 1;
      continue;
    }
    const octal = payload.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      flush(i);
      out.push(parseInt(octal, 8) & 0xff);
      i += 3;
      literalStart = i + 1;
    }
    /* A lone backslash tmux did not escape: leave it in the literal run. */
  }
  flush(payload.length);
  return new Uint8Array(out);
}

/** Classifies one line of control-mode output. */
export function parseControlLine(line: string): ControlEvent {
  if (!line.startsWith("%")) return { kind: "line", text: line };

  if (line.startsWith("%output ")) {
    const rest = line.slice("%output ".length);
    const sp = rest.indexOf(" ");
    /* No payload at all is legal — a pane that emitted nothing but a flush. */
    if (sp === -1) return { kind: "output", pane: rest, data: new Uint8Array(0) };
    return {
      kind: "output",
      pane: rest.slice(0, sp),
      data: unescapeOutput(rest.slice(sp + 1)),
    };
  }

  if (line === "%exit" || line.startsWith("%exit ")) {
    return { kind: "exit", reason: line.slice("%exit".length).trim() };
  }

  if (line.startsWith("%begin")) return { kind: "block", name: "begin" };
  if (line.startsWith("%end")) return { kind: "block", name: "end" };
  if (line.startsWith("%error")) return { kind: "block", name: "error" };

  const sp = line.indexOf(" ");
  const name = (sp === -1 ? line : line.slice(0, sp)).slice(1);
  return { kind: "notification", name, args: sp === -1 ? "" : line.slice(sp + 1) };
}

/** Notifications after which the session's active pane may be a different one. */
const PANE_MAY_HAVE_MOVED = new Set([
  "layout-change",
  "window-add",
  "window-close",
  "window-pane-changed",
  "session-changed",
  "session-window-changed",
]);

export interface ControlClient {
  /** The pane whose output is being forwarded, or null until it resolves. */
  pane(): string | null;
  /** A control-mode command line, sent as-is. Fire and forget. */
  send(command: string): void;
  /** Tells tmux this viewer's size. With window-size=latest this resizes the
   *  window, which is the point — the browser is the real viewer. */
  resize(cols: number, rows: number): void;
  /** Everything the pane has written since the last flush. */
  onOutput(cb: (data: Uint8Array) => void): void;
  /** The session went away, or tmux did. */
  onExit(cb: (reason: string) => void): void;
  /** Discards anything buffered so far. Used once, after the initial capture,
   *  so bytes already on the captured screen are not written a second time. */
  dropBuffered(): void;
  close(): void;
}

export interface AttachOptions {
  /** Injected in tests. Defaults to spawning the real tmux. */
  spawn?: (args: string[]) => ControlProcess;
  /** Resolves the session's active pane id. Defaults to a one-off tmux spawn. */
  resolvePane?: (session: string) => Promise<string | null>;
}

/** The slice of a spawned process this needs, so tests can stand in for it. */
export interface ControlProcess {
  stdout: ReadableStream<Uint8Array>;
  write(text: string): void;
  kill(): void;
  exited: Promise<unknown>;
}

function spawnControl(args: string[]): ControlProcess {
  const proc = Bun.spawn(["tmux", ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  return {
    stdout: proc.stdout as unknown as ReadableStream<Uint8Array>,
    write: (text) => {
      try {
        const stdin = proc.stdin as { write: (s: string) => void; flush?: () => void };
        stdin.write(text);
        stdin.flush?.();
      } catch {
        /* The child is gone; onExit will fire. */
      }
    },
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
    },
    exited: proc.exited,
  };
}

async function resolvePaneViaSpawn(session: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["tmux", "display-message", "-p", "-t", session, "#{pane_id}"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout as any).text();
    const id = text.trim();
    return id.startsWith("%") ? id : null;
  } catch {
    return null;
  }
}

/**
 * Attaches to a session in control mode and streams its active pane.
 *
 * Returns null when tmux cannot be attached at all, so the caller can fall back
 * to polling rather than leave the terminal blank.
 */
export async function attachControl(
  session: string,
  opts: AttachOptions = {},
): Promise<ControlClient | null> {
  const spawn = opts.spawn ?? spawnControl;
  const resolvePane = opts.resolvePane ?? resolvePaneViaSpawn;

  let proc: ControlProcess;
  try {
    proc = spawn(["-C", "attach-session", "-t", session]);
  } catch {
    return null;
  }

  let pane: string | null = null;
  let closed = false;
  let dropping = true;
  let outputCb: ((data: Uint8Array) => void) | null = null;
  let exitCb: ((reason: string) => void) | null = null;
  const pending: Uint8Array[] = [];

  /* Resolved out of band: see the note about %begin/%end at the top. */
  const panePromise = resolvePane(session).then((p) => {
    pane = p;
    return p;
  });

  let paneRefresh: ReturnType<typeof setTimeout> | null = null;
  const refreshPaneSoon = () => {
    if (paneRefresh || closed) return;
    paneRefresh = setTimeout(() => {
      paneRefresh = null;
      if (closed) return;
      resolvePane(session)
        .then((p) => {
          if (p) pane = p;
        })
        .catch(() => {});
    }, 150);
  };

  const emit = (data: Uint8Array) => {
    if (data.length === 0) return;
    if (dropping) {
      pending.push(data);
      /* A runaway pane must not become a memory leak while we wait for the
         initial capture, which takes milliseconds. */
      if (pending.length > 500) pending.shift();
      return;
    }
    outputCb?.(data);
  };

  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    if (paneRefresh) clearTimeout(paneRefresh);
    exitCb?.(reason);
  };

  /* Read forever in the background: one line at a time, keeping the tail of a
     chunk that stopped mid-line. */
  (async () => {
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    try {
      for await (const chunk of proc.stdout as any) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const ev = parseControlLine(line.endsWith("\r") ? line.slice(0, -1) : line);
          if (ev.kind === "output") {
            /* Before the pane id lands, forward whatever the session emits:
               these sessions are single-pane, and a blank terminal is worse
               than a stray byte. */
            if (pane === null || ev.pane === pane) emit(ev.data);
          } else if (ev.kind === "exit") {
            finish(ev.reason || "session ended");
          } else if (ev.kind === "notification" && PANE_MAY_HAVE_MOVED.has(ev.name)) {
            refreshPaneSoon();
          }
        }
      }
    } catch {
      /* Stream torn down — the exit below reports it. */
    }
    finish("control stream ended");
  })();

  proc.exited.then(() => finish("tmux exited")).catch(() => finish("tmux exited"));

  /* Confirms the session exists before the caller commits to this path. */
  const resolved = await panePromise.catch(() => null);
  if (resolved === null && closed) {
    proc.kill();
    return null;
  }

  return {
    pane: () => pane,
    send: (command) => {
      if (!closed) proc.write(`${command}\n`);
    },
    resize: (cols, rows) => {
      if (closed) return;
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
      const c = Math.max(20, Math.min(500, Math.round(cols)));
      const r = Math.max(5, Math.min(200, Math.round(rows)));
      proc.write(`refresh-client -C ${c}x${r}\n`);
    },
    onOutput: (cb) => {
      outputCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
      if (closed) cb("session ended");
    },
    dropBuffered: () => {
      pending.length = 0;
      dropping = false;
    },
    close: () => {
      if (closed) {
        proc.kill();
        return;
      }
      closed = true;
      if (paneRefresh) clearTimeout(paneRefresh);
      proc.write("detach-client\n");
      proc.kill();
    },
  };
}
