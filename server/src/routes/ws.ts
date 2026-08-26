import { hasSession } from "../services/tmux";
import { attachPty, type PtyClient } from "../services/tmux-pty";

const HEARTBEAT_TIMEOUT_MS = 60_000;

export async function handleWsOpen(
  ws: any,
  sessionName: string,
  size?: { cols: number; rows: number },
) {
  console.log(`[ws] open: session="${sessionName}"`);

  if (!await hasSession(sessionName)) {
    ws.send(JSON.stringify({ type: "error", data: "Session not found" }));
    ws.close();
    return;
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
 * cursor, mouse copy mode and redraws; the server owns only transport and
 * connection lifecycle.
 */
function streamPty(ws: any, sessionName: string, pty: PtyClient) {
  let stopped = false;
  let lastClientActivity = Date.now();

  pty.onOutput((data) => {
    if (stopped) return;
    try {
      ws.send(data);
    } catch {
      /* Socket went away between the check and the send. */
    }
  });

  function cleanup() {
    if (stopped) return;
    stopped = true;
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
