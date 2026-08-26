import { describe, expect, test } from "bun:test";
import { handleWsClose, handleWsMessage } from "../routes/ws";
import type { PtyClient } from "../services/tmux-pty";

function fakeSocket() {
  const writes: string[] = [];
  const sizes: Array<[number, number]> = [];
  const sent: unknown[] = [];
  let touched = 0;
  let cleaned = 0;
  let intervalCleared = false;

  const pty: PtyClient = {
    write: (data) => writes.push(data),
    resize: (cols, rows) => sizes.push([cols, rows]),
    onOutput: () => {},
    onExit: () => {},
    close: () => {},
  };
  const heartbeatInterval = setInterval(() => {}, 60_000);
  const ws = {
    data: {
      sessionName: "claude-one",
      pty,
      heartbeatInterval,
      touchActivity: () => { touched += 1; },
      cleanup: () => {
        cleaned += 1;
        clearInterval(heartbeatInterval);
        intervalCleared = true;
      },
    },
    send: (data: unknown) => sent.push(data),
  };

  return {
    ws,
    writes,
    sizes,
    sent,
    touched: () => touched,
    cleaned: () => cleaned,
    intervalCleared: () => intervalCleared,
  };
}

describe("PTY WebSocket protocol", () => {
  test("forwards input bytes without translating terminal keys", () => {
    const f = fakeSocket();
    handleWsMessage(f.ws, JSON.stringify({ type: "input", data: "a\r\x1b[A" }));
    expect(f.writes).toEqual(["a\r\x1b[A"]);
    expect(f.touched()).toBe(1);
    handleWsClose(f.ws);
  });

  test("forwards Shift+Enter's CSI-u sequence", () => {
    const f = fakeSocket();
    handleWsMessage(f.ws, JSON.stringify({ type: "shift-enter" }));
    expect(f.writes).toEqual(["\x1b[13;2u"]);
    handleWsClose(f.ws);
  });

  test("forwards valid resize messages only", () => {
    const f = fakeSocket();
    handleWsMessage(f.ws, JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    handleWsMessage(f.ws, JSON.stringify({ type: "resize", cols: "120", rows: 40 }));
    expect(f.sizes).toEqual([[120, 40]]);
    handleWsClose(f.ws);
  });

  test("answers ping even before a PTY is attached", () => {
    const f = fakeSocket();
    delete (f.ws.data as { pty?: PtyClient }).pty;
    handleWsMessage(f.ws, JSON.stringify({ type: "ping" }));
    expect(f.sent).toEqual([JSON.stringify({ type: "pong" })]);
    handleWsClose(f.ws);
  });

  test("ignores malformed and unknown messages without closing", () => {
    const f = fakeSocket();
    handleWsMessage(f.ws, "{");
    handleWsMessage(f.ws, JSON.stringify({ type: "unknown", data: "nope" }));
    expect(f.writes).toEqual([]);
    expect(f.sizes).toEqual([]);
    expect(f.touched()).toBe(2);
    handleWsClose(f.ws);
  });

  test("close runs transport cleanup", () => {
    const f = fakeSocket();
    handleWsClose(f.ws);
    expect(f.cleaned()).toBe(1);
    expect(f.intervalCleared()).toBe(true);
  });
});
