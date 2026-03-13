import { useEffect, useRef, useState, useCallback } from "react";
import { wsUrl } from "../api";
import { isDemo, getDemoSnapshot } from "../demo";

interface WsMessage {
  type: "snapshot" | "update" | "closed" | "error" | "pong";
  data: unknown;
}

// Send a ping every 30s to keep the server heartbeat alive
const PING_INTERVAL_MS = 30_000;

// Batch printable input for this long before flushing
const INPUT_BATCH_MS = 30;

// Characters that must be sent immediately (not batched)
const SPECIAL_CHARS = new Set(["\r", "\n", "\x7f", "\x1b", "\t"]);

export function useWebSocket(
  sessionName: string,
  onData: (data: unknown) => void,
  onClosed?: () => void,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pingInterval = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const onDataRef = useRef(onData);
  const onClosedRef = useRef(onClosed);
  onDataRef.current = onData;
  onClosedRef.current = onClosed;

  useEffect(() => {
    if (isDemo()) {
      setConnected(true);
      setTimeout(() => onDataRef.current(getDemoSnapshot(sessionName)), 100);
      return;
    }

    let stopped = false;

    function connect() {
      if (stopped) return;
      if (wsRef.current?.readyState === WebSocket.OPEN) return;

      const ws = new WebSocket(wsUrl(sessionName));
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        // Start sending pings to keep server heartbeat alive
        pingInterval.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        try {
          const msg: WsMessage = JSON.parse(event.data);
          if (msg.type === "snapshot" || msg.type === "update") {
            onDataRef.current(msg.data);
          } else if (msg.type === "closed") {
            onClosedRef.current?.();
          }
          // "pong" is just an ack, no action needed
        } catch {
          // Ignore parse errors
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (pingInterval.current) clearInterval(pingInterval.current);
        if (!stopped) {
          reconnectTimeout.current = setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    // Pause WebSocket when tab is hidden, reconnect when visible
    function handleVisibility() {
      if (document.hidden) {
        // Tab hidden — close connection to stop server-side polling
        stopped = true;
        clearTimeout(reconnectTimeout.current);
        if (pingInterval.current) clearInterval(pingInterval.current);
        wsRef.current?.close();
      } else {
        // Tab visible again — reconnect
        stopped = false;
        connect();
      }
    }

    connect();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      clearTimeout(reconnectTimeout.current);
      if (pingInterval.current) clearInterval(pingInterval.current);
      if (flushTimer.current) clearTimeout(flushTimer.current);
      inputBuffer.current = "";
      wsRef.current?.close();
    };
  }, [sessionName]);

  // --- Input buffering: batch printable chars, flush before special keys ---
  const inputBuffer = useRef("");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flushBuffer = useCallback(() => {
    if (inputBuffer.current && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "input", data: inputBuffer.current }));
    }
    inputBuffer.current = "";
    flushTimer.current = undefined;
  }, []);

  const sendInput = useCallback((data: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;

    const isSpecial = SPECIAL_CHARS.has(data) || data.startsWith("\x1b");

    if (isSpecial) {
      // Flush any pending printable text first
      if (inputBuffer.current) {
        wsRef.current.send(JSON.stringify({ type: "input", data: inputBuffer.current }));
        inputBuffer.current = "";
      }
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = undefined;
      }
      // Send special key immediately
      wsRef.current.send(JSON.stringify({ type: "input", data }));
    } else {
      // Buffer printable text
      inputBuffer.current += data;
      if (!flushTimer.current) {
        flushTimer.current = setTimeout(flushBuffer, INPUT_BATCH_MS);
      }
    }
  }, [flushBuffer]);

  const sendShiftEnter = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      // Flush buffer before special key
      if (inputBuffer.current) {
        wsRef.current.send(JSON.stringify({ type: "input", data: inputBuffer.current }));
        inputBuffer.current = "";
      }
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = undefined;
      }
      wsRef.current.send(JSON.stringify({ type: "shift-enter" }));
    }
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  }, []);

  return { connected, sendInput, sendShiftEnter, sendResize };
}
