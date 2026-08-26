import { useCallback, useEffect, useRef, useState } from "react";
import { wsUrl } from "../api";
import { getDemoSnapshot, isDemo } from "../demo";

interface WsMessage {
  type: "closed" | "error" | "pong";
  data?: unknown;
}

const PING_INTERVAL_MS = 30_000;

export interface TerminalSocketOptions {
  onBytes: (bytes: Uint8Array) => void;
  onClosed?: () => void;
  getTerminalSize?: () => { cols: number; rows: number } | undefined;
  /**
   * Attaching sizes the tmux window, so the socket stays shut until the caller
   * has a real grid to attach at. Connecting first and correcting afterwards
   * squeezes the window down to xterm's unmeasured default and back, and tmux
   * repaints the screen each way.
   */
  ready?: boolean;
}

export function useWebSocket(sessionName: string, options: TerminalSocketOptions) {
  const { onBytes, onClosed, getTerminalSize, ready = true } = options;
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pingInterval = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const onBytesRef = useRef(onBytes);
  const onClosedRef = useRef(onClosed);
  const getTerminalSizeRef = useRef(getTerminalSize);
  onBytesRef.current = onBytes;
  onClosedRef.current = onClosed;
  getTerminalSizeRef.current = getTerminalSize;

  useEffect(() => {
    if (!ready) return;

    if (isDemo()) {
      setConnected(true);
      const timer = setTimeout(() => {
        const snapshot = getDemoSnapshot(sessionName);
        if (snapshot && typeof snapshot.content === "string") {
          onBytesRef.current(new TextEncoder().encode(snapshot.content));
        }
      }, 100);
      return () => clearTimeout(timer);
    }

    let stopped = false;

    function connect() {
      if (stopped || wsRef.current?.readyState === WebSocket.OPEN) return;

      const ws = new WebSocket(wsUrl(sessionName, getTerminalSizeRef.current?.()));
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        pingInterval.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          onBytesRef.current(new Uint8Array(event.data));
          return;
        }
        if (typeof event.data !== "string") return;
        try {
          const msg: WsMessage = JSON.parse(event.data);
          if (msg.type === "closed" || msg.type === "error") onClosedRef.current?.();
        } catch {
          /* PTY output is binary; unknown text frames are not terminal data. */
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (pingInterval.current) clearInterval(pingInterval.current);
        if (!stopped) reconnectTimeout.current = setTimeout(connect, 2000);
      };

      ws.onerror = () => ws.close();
    }

    function handleVisibility() {
      if (document.hidden) {
        stopped = true;
        clearTimeout(reconnectTimeout.current);
        if (pingInterval.current) clearInterval(pingInterval.current);
        wsRef.current?.close();
      } else {
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
      wsRef.current?.close();
    };
  }, [sessionName, ready]);

  const send = useCallback((message: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const sendInput = useCallback((data: string) => send({ type: "input", data }), [send]);
  const sendShiftEnter = useCallback(() => send({ type: "shift-enter" }), [send]);
  const sendResize = useCallback(
    (cols: number, rows: number) => send({ type: "resize", cols, rows }),
    [send],
  );

  return { connected, sendInput, sendShiftEnter, sendResize };
}
