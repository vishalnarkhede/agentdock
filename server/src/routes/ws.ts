import { capturePaneSnapshot, hasSession, sendKeysRaw, sendSpecialKey, resizePane } from "../services/tmux";
import { attachControl, type ControlClient } from "../services/tmux-control";

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

/* Streaming is the default path; AGENTDOCK_STREAM=0 forces the polling one,
   which is also the automatic fallback when tmux cannot be attached. */
const STREAM_ENABLED = process.env.AGENTDOCK_STREAM !== "0";

/* How often a streamed pane is re-captured so the client can check its copy
   against it, and how quiet the stream has to be first. Streaming makes the
   browser a mirror rather than a re-render, and a mirror can drift — a dropped
   frame or a sequence read differently leaves a wrong cell there until
   something repaints. This is the check that catches it, at one capture per
   lull instead of the five a second the polling path did. */
const RESYNC_MS = 4000;
const RESYNC_QUIET_MS = 900;

export async function handleWsOpen(ws: any, sessionName: string) {
  console.log(`[ws] open: session="${sessionName}"`);

  /* With scrollback: tmux owns the pane's history, so whatever this capture
     does not carry is history the reader cannot reach — xterm's buffer starts
     empty and only grows from what the stream appends after this point. */
  const result = await capturePaneSnapshot(sessionName, 200);
  if (!result.ok) {
    console.error(`[ws] snapshot failed: ${result.error}`);
    ws.send(JSON.stringify({ type: "error", data: result.error }));
    ws.close();
    return;
  }

  /* Control mode: one long-lived tmux client streaming this pane's bytes, in
     place of ten process spawns a second and a full-pane repaint per frame.
     The initial screen still comes from a capture — attaching does not replay
     what is already on the pane — and anything the stream buffered while that
     capture was in flight is dropped, because the capture already shows it. */
  let initial = result.data;

  if (STREAM_ENABLED) {
    const control = await attachControl(sessionName);
    if (control) {
      streamPane(ws, sessionName, control, initial);
      return;
    }
    console.warn(`[ws] control mode unavailable, polling: session="${sessionName}"`);
  }

  ws.send(JSON.stringify({ type: "mode", mode: "snapshot" }));
  ws.send(JSON.stringify({ type: "snapshot", data: initial }));

  // Adaptive polling state
  let lastSnapshot = JSON.stringify(initial);
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

/**
 * The streaming path: paint once from a capture, then forward bytes.
 *
 * Nothing polls here. The heartbeat stays, because a client that goes away
 * without closing the socket is still the common case on a phone.
 */
function streamPane(ws: any, sessionName: string, control: ControlClient, initial: unknown) {
  let stopped = false;
  let lastClientActivity = Date.now();

  ws.send(JSON.stringify({ type: "mode", mode: "stream" }));
  ws.send(JSON.stringify({ type: "snapshot", data: initial }));
  /* Everything up to here is on the captured screen already. */
  control.dropBuffered();

  let lastOutputAt = 0;
  let changedSinceResync = false;

  control.onOutput((bytes) => {
    if (stopped) return;
    lastOutputAt = Date.now();
    changedSinceResync = true;
    try {
      ws.send(bytes);
    } catch {
      /* Socket went away between the check and the send. */
    }
  });

  /* Only after something changed, and only once the stream goes quiet: during a
     burst the screen is about to be overwritten anyway, and a capture taken
     mid-redraw would disagree with the client for reasons that are not drift. */
  const resyncTimer = setInterval(async () => {
    if (stopped || !changedSinceResync) return;
    if (Date.now() - lastOutputAt < RESYNC_QUIET_MS) return;
    changedSinceResync = false;
    const snap = await capturePaneSnapshot(sessionName, 0);
    if (stopped || !snap.ok) return;
    try {
      ws.send(JSON.stringify({ type: "resync", data: snap.data }));
    } catch {
      /* Socket went away mid-capture. */
    }
  }, RESYNC_MS);

  function cleanup() {
    if (stopped) return;
    stopped = true;
    clearInterval(resyncTimer);
    control.close();
    if (ws.data?.heartbeatInterval) clearInterval(ws.data.heartbeatInterval);
  }

  control.onExit((reason) => {
    if (stopped) return;
    try {
      ws.send(JSON.stringify({ type: "closed", data: reason || "Session ended" }));
    } catch {
      /* already gone */
    }
    cleanup();
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  });

  const heartbeatInterval = setInterval(() => {
    if (Date.now() - lastClientActivity > HEARTBEAT_TIMEOUT_MS) {
      console.log(`[ws] heartbeat timeout: session="${sessionName}"`);
      cleanup();
      clearInterval(heartbeatInterval);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }, 15_000);

  ws.data = {
    cleanup,
    heartbeatInterval,
    sessionName,
    streaming: true,
    /* Polling concepts the message handler still asks for. */
    nudgePoll: () => {},
    touchActivity: () => {
      lastClientActivity = Date.now();
    },
  };
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
