import { hasSession } from "../services/tmux";
import { attachPty, scrollPtySession, settlePtyWindow, type PtyClient } from "../services/tmux-pty";

const HEARTBEAT_TIMEOUT_MS = 60_000;

export async function handleWsOpen(
  ws: any,
  sessionName: string,
  size?: { cols: number; rows: number },
) {
  const openedAt = Date.now();
  const grid = size ? `${size.cols}x${size.rows}` : "unmeasured";
  console.log(`[ws] open: session="${sessionName}" grid=${grid}`);

  if (!await hasSession(sessionName)) {
    ws.send(JSON.stringify({ type: "error", data: "Session not found" }));
    ws.close();
    return;
  }

  /* Before the PTY exists, so that the redraw a size change provokes happens
     with nobody watching it. */
  if (await settlePtyWindow(sessionName, size)) {
    // Only when the window actually had to move, which says the agent was made
    // to redraw — the one thing that delays an open.
    console.log(`[ws] resized to ${grid} in ${Date.now() - openedAt}ms: session="${sessionName}"`);
  }

  const pty = attachPty(sessionName, size);
  if (!pty) {
    console.error(`[ws] PTY attach failed: session="${sessionName}"`);
    ws.send(JSON.stringify({ type: "error", data: "Unable to attach terminal" }));
    ws.close();
    return;
  }

  streamPty(ws, sessionName, pty);
}

/**
 * Relay one authoritative PTY byte stream. tmux owns the screen, history,
 * cursor and redraws; the server owns only transport and connection lifecycle.
 */
function streamPty(ws: any, sessionName: string, pty: PtyClient) {
  let stopped = false;
  let lastClientActivity = Date.now();

  /* Output is gathered for a few milliseconds before it is sent.
     
     A redrawing agent TUI writes its screen in tiny pieces — a full-screen
     Cursor redraw measured 81,000 PTY chunks of about twelve bytes in three
     seconds — and forwarding each one as its own frame made the browser parse
     and repaint that many times. xterm then rendered the redraw a fragment at a
     time for over a second, which is what a session opening looked like: the
     screen filling and scrolling as it caught up. Batched, the same redraw
     arrives as a few dozen frames and lands in one repaint.
     
     Small enough to stay under a frame, so nothing about typing feels slower:
     input travels the other way and is never delayed. */
  const FLUSH_MS = 8;
  /* And a burst larger than this goes at once rather than growing the buffer. */
  const FLUSH_BYTES = 64 * 1024;

  let queue: Uint8Array[] = [];
  let queued = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (stopped || queued === 0) return;
    let out: Uint8Array;
    if (queue.length === 1) {
      out = queue[0]!;
    } else {
      out = new Uint8Array(queued);
      let at = 0;
      for (const part of queue) {
        out.set(part, at);
        at += part.length;
      }
    }
    queue = [];
    queued = 0;
    try {
      ws.send(out);
    } catch {
      /* Socket went away between the check and the send. */
    }
  }

  pty.onOutput((data) => {
    if (stopped) return;
    // Copied: Bun may reuse the callback's buffer once it returns, and this one
    // is kept until the flush.
    queue.push(data.slice());
    queued += data.length;
    if (queued >= FLUSH_BYTES) {
      flush();
      return;
    }
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  });

  function cleanup() {
    if (stopped) return;
    stopped = true;
    if (flushTimer) clearTimeout(flushTimer);
    queue = [];
    queued = 0;
    pty.close();
    if (ws.data?.heartbeatInterval) clearInterval(ws.data.heartbeatInterval);
  }

  pty.onExit((reason) => {
    if (stopped) return;
    try {
      ws.send(JSON.stringify({ type: "closed", data: reason || "terminal detached" }));
    } catch {}
    cleanup();
    try {
      ws.close();
    } catch {}
  });

  const heartbeatInterval = setInterval(() => {
    if (Date.now() - lastClientActivity <= HEARTBEAT_TIMEOUT_MS) return;
    console.log(`[ws] heartbeat timeout: session="${sessionName}"`);
    cleanup();
    try {
      ws.close();
    } catch {}
  }, 15_000);

  ws.data = {
    cleanup,
    heartbeatInterval,
    sessionName,
    pty,
    touchActivity: () => {
      lastClientActivity = Date.now();
    },
  };
}

export function handleWsMessage(ws: any, message: string | Buffer) {
  const pty = ws.data?.pty as PtyClient | undefined;
  const sessionName = ws.data?.sessionName;
  if (!sessionName) return;

  ws.data?.touchActivity?.();

  try {
    const msg = JSON.parse(typeof message === "string" ? message : message.toString());

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (!pty) return;

    if (msg.type === "shift-enter") {
      pty.write("\x1b[13;2u");
    } else if (
      msg.type === "resize"
      && typeof msg.cols === "number"
      && typeof msg.rows === "number"
    ) {
      pty.resize(msg.cols, msg.rows);
    } else if (msg.type === "input" && typeof msg.data === "string") {
      pty.write(msg.data);
    } else if (msg.type === "scroll" && typeof msg.lines === "number") {
      /* Not written into the PTY: the history belongs to tmux, not to the
         program on the other end of it, and a wheel must not look like input. */
      scrollPtySession(sessionName, msg.lines);
    }
  } catch {
    /* Ignore malformed client messages; the connection remains usable. */
  }
}

export function handleWsClose(ws: any) {
  ws.data?.cleanup?.();
  if (ws.data?.heartbeatInterval) clearInterval(ws.data.heartbeatInterval);
  console.log(`[ws] closed: session="${ws.data?.sessionName}"`);
}
