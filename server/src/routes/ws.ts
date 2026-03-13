import { capturePaneSnapshot, hasSession, sendKeysRaw, sendSpecialKey, resizePane } from "../services/tmux";

export function handleWebSocket(server: any) {
  // WebSocket upgrade and handling is done in the Bun.serve config
}

const MIN_POLL_MS = 200;
const MAX_POLL_MS = 2000;
const POLL_BACKOFF = 1.5;
// Poll faster right after user input for snappier feedback
const INPUT_POLL_MS = 50;
// If no message received from client in 60s, consider connection dead
const HEARTBEAT_TIMEOUT_MS = 60_000;

export async function handleWsOpen(ws: any, sessionName: string) {
  console.log(`[ws] open: session="${sessionName}"`);

  // Send initial snapshot
  const result = await capturePaneSnapshot(sessionName);
  if (!result.ok) {
    console.error(`[ws] snapshot failed: ${result.error}`);
    ws.send(JSON.stringify({ type: "error", data: result.error }));
    ws.close();
    return;
  }

  ws.send(JSON.stringify({ type: "snapshot", data: result.data }));

  // Adaptive polling state
  let lastSnapshot = JSON.stringify(result.data);
  let pollMs = MIN_POLL_MS;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let lastClientActivity = Date.now();
  let stopped = false;

  function cleanup() {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (ws.data?.heartbeatInterval) {
      clearInterval(ws.data.heartbeatInterval);
    }
  }

  async function poll() {
    if (stopped) return;

    try {
      const exists = await hasSession(sessionName);
      if (!exists) {
        ws.send(JSON.stringify({ type: "closed", data: "Session ended" }));
        cleanup();
        ws.close();
        return;
      }
      const snap = await capturePaneSnapshot(sessionName);
      if (snap.ok) {
        const serialized = JSON.stringify(snap.data);
        if (serialized !== lastSnapshot) {
          lastSnapshot = serialized;
          ws.send(JSON.stringify({ type: "update", data: snap.data }));
          // Content changed — poll fast
          pollMs = MIN_POLL_MS;
        } else {
          // No change — back off
          pollMs = Math.min(pollMs * POLL_BACKOFF, MAX_POLL_MS);
        }
      }
    } catch {
      // tmux command failed, back off
      pollMs = MAX_POLL_MS;
    }

    if (!stopped) {
      pollTimer = setTimeout(poll, pollMs);
    }
  }

  // Start polling
  pollTimer = setTimeout(poll, pollMs);

  // Heartbeat: detect dead connections where onclose never fired
  const heartbeatInterval = setInterval(() => {
    if (Date.now() - lastClientActivity > HEARTBEAT_TIMEOUT_MS) {
      console.log(`[ws] heartbeat timeout: session="${sessionName}"`);
      cleanup();
      clearInterval(heartbeatInterval);
      ws.close();
    }
  }, 15_000);

  // Reset poll to fast on client input (avoids lag after backoff)
  function nudgePoll() {
    if (stopped) return;
    pollMs = MIN_POLL_MS;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, INPUT_POLL_MS);
  }

  // Store cleanup handles
  ws.data = { cleanup, heartbeatInterval, sessionName, nudgePoll, touchActivity: () => { lastClientActivity = Date.now(); } };
}

const SPECIAL_KEYS: Record<string, string> = {
  "\r": "Enter",
  "\n": "Enter",
  "\x7f": "BSpace",
  "\x1b": "Escape",
  "\t": "Tab",
  "\x1b[A": "Up",
  "\x1b[B": "Down",
  "\x1b[C": "Right",
  "\x1b[D": "Left",
};

export async function handleWsMessage(ws: any, message: string | Buffer) {
  const sessionName = ws.data?.sessionName;
  if (!sessionName) return;

  // Any message from client counts as activity (keeps heartbeat alive)
  ws.data?.touchActivity?.();

  try {
    const msg = JSON.parse(typeof message === "string" ? message : message.toString());

    // Client heartbeat ping
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    // Shift+Enter: send the CSI u escape sequence for Shift+Enter
    // Claude Code detects this via extended key encoding (kitty keyboard protocol)
    if (msg.type === "shift-enter") {
      await sendKeysRaw(sessionName, "\x1b[13;2u");
      ws.data?.nudgePoll?.();
      return;
    }

    if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
      await resizePane(sessionName, msg.cols, msg.rows);
      ws.data?.nudgePoll?.();
      return;
    }

    if (msg.type === "input" && typeof msg.data === "string") {
      const input = msg.data;
      const special = SPECIAL_KEYS[input];
      if (special) {
        await sendSpecialKey(sessionName, special);
      } else if (input.startsWith("\x1b")) {
        // Other escape sequences — send as-is (tmux interprets them)
        await sendSpecialKey(sessionName, input);
      } else {
        await sendKeysRaw(sessionName, input);
      }
      ws.data?.nudgePoll?.();
    }
  } catch {
    // Ignore malformed messages
  }
}

export function handleWsClose(ws: any) {
  ws.data?.cleanup?.();
  if (ws.data?.heartbeatInterval) {
    clearInterval(ws.data.heartbeatInterval);
  }
  console.log(`[ws] closed: session="${ws.data?.sessionName}"`);
}
