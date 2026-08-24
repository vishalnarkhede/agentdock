/**
 * Tests for tmux-control.ts — the control-mode parser and the attach lifecycle.
 *
 * The parser cases are taken from real tmux 3.6a output captured off a scratch
 * session; the lifecycle ones drive a fake process so nothing here needs tmux.
 */

import { describe, test, expect } from "bun:test";
import {
  attachControl,
  parseControlLine,
  unescapeOutput,
  type ControlProcess,
} from "../services/tmux-control";

const dec = new TextDecoder();
const text = (u: Uint8Array) => dec.decode(u);

describe("unescapeOutput", () => {
  test("passes printable text through", () => {
    expect(text(unescapeOutput("hello-stream"))).toBe("hello-stream");
  });

  test("decodes octal escapes", () => {
    expect(text(unescapeOutput("a\\015\\012b"))).toBe("a\r\nb");
  });

  test("decodes an escape byte", () => {
    expect(text(unescapeOutput("\\033[?2004l"))).toBe("\x1b[?2004l");
  });

  test("decodes a real captured line", () => {
    expect(text(unescapeOutput("echo hello-stream\\015\\012\\033[?2004l\\015"))).toBe(
      "echo hello-stream\r\n\x1b[?2004l\r",
    );
  });

  test("unescapes a doubled backslash to one", () => {
    expect(text(unescapeOutput("C:\\\\path"))).toBe("C:\\path");
  });

  test("keeps a lone backslash tmux did not escape", () => {
    expect(text(unescapeOutput("a\\zb"))).toBe("a\\zb");
  });

  test("keeps multibyte UTF-8 intact", () => {
    expect(text(unescapeOutput("✓ döne — ✱"))).toBe("✓ döne — ✱");
  });

  test("does not treat two digits as an octal escape", () => {
    expect(text(unescapeOutput("\\01"))).toBe("\\01");
  });

  test("handles an empty payload", () => {
    expect(unescapeOutput("").length).toBe(0);
  });

  test("decodes a high byte", () => {
    expect(unescapeOutput("\\377")[0]).toBe(0xff);
  });
});

describe("parseControlLine", () => {
  test("reads pane and payload out of %output", () => {
    const ev = parseControlLine("%output %11 hi\\015\\012");
    expect(ev.kind).toBe("output");
    if (ev.kind !== "output") return;
    expect(ev.pane).toBe("%11");
    expect(text(ev.data)).toBe("hi\r\n");
  });

  test("accepts %output with no payload", () => {
    const ev = parseControlLine("%output %11");
    expect(ev.kind).toBe("output");
    if (ev.kind !== "output") return;
    expect(ev.pane).toBe("%11");
    expect(ev.data.length).toBe(0);
  });

  test("keeps spaces inside a payload", () => {
    const ev = parseControlLine("%output %3 two  spaces");
    if (ev.kind !== "output") throw new Error("expected output");
    expect(text(ev.data)).toBe("two  spaces");
  });

  test("recognises %exit with and without a reason", () => {
    expect(parseControlLine("%exit")).toEqual({ kind: "exit", reason: "" });
    expect(parseControlLine("%exit server exited")).toEqual({
      kind: "exit",
      reason: "server exited",
    });
  });

  test("recognises reply blocks", () => {
    expect(parseControlLine("%begin 1787572746 6512562 0")).toEqual({
      kind: "block",
      name: "begin",
    });
    expect(parseControlLine("%end 1787572746 6512562 0")).toEqual({ kind: "block", name: "end" });
    expect(parseControlLine("%error 1 2 3")).toEqual({ kind: "block", name: "error" });
  });

  test("names other notifications", () => {
    expect(parseControlLine("%layout-change @11 55b0,120x40,0,0,11")).toEqual({
      kind: "notification",
      name: "layout-change",
      args: "@11 55b0,120x40,0,0,11",
    });
    expect(parseControlLine("%sessions-changed")).toEqual({
      kind: "notification",
      name: "sessions-changed",
      args: "",
    });
  });

  test("treats a line inside a reply block as data", () => {
    expect(parseControlLine("120x40")).toEqual({ kind: "line", text: "120x40" });
  });
});

/** A process whose stdout we push into by hand. */
function fakeProcess() {
  let push: (s: string) => void = () => {};
  let done: () => void = () => {};
  const written: string[] = [];
  let killed = false;
  let exit: () => void = () => {};

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      push = (s) => controller.enqueue(enc.encode(s));
      done = () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
    },
  });

  const proc: ControlProcess = {
    stdout,
    write: (t) => written.push(t),
    kill: () => {
      killed = true;
      done();
      exit();
    },
    exited: new Promise<void>((res) => {
      exit = res;
    }),
  };

  return {
    proc,
    push: (s: string) => push(s),
    endStream: () => done(),
    written,
    killed: () => killed,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 15));

describe("attachControl", () => {
  test("forwards output for the resolved pane only", async () => {
    const f = fakeProcess();
    const client = await attachControl("s", {
      spawn: () => f.proc,
      resolvePane: async () => "%7",
    });
    expect(client).not.toBeNull();
    const seen: string[] = [];
    client!.onOutput((d) => seen.push(text(d)));
    client!.dropBuffered();

    f.push("%output %7 keep\\015\\012\n%output %9 drop\n%output %7 also\n");
    await settle();
    expect(seen).toEqual(["keep\r\n", "also"]);
    client!.close();
  });

  test("buffers until dropBuffered, then drops what it buffered", async () => {
    const f = fakeProcess();
    const client = await attachControl("s", {
      spawn: () => f.proc,
      resolvePane: async () => "%1",
    });
    const seen: string[] = [];
    client!.onOutput((d) => seen.push(text(d)));

    f.push("%output %1 already-on-screen\n");
    await settle();
    expect(seen).toEqual([]);

    client!.dropBuffered();
    f.push("%output %1 after\n");
    await settle();
    expect(seen).toEqual(["after"]);
    client!.close();
  });

  test("reassembles a line split across two chunks", async () => {
    const f = fakeProcess();
    const client = await attachControl("s", { spawn: () => f.proc, resolvePane: async () => "%1" });
    const seen: string[] = [];
    client!.onOutput((d) => seen.push(text(d)));
    client!.dropBuffered();

    f.push("%output %1 half");
    await settle();
    expect(seen).toEqual([]);
    f.push("-and-half\n");
    await settle();
    expect(seen).toEqual(["half-and-half"]);
    client!.close();
  });

  test("reports %exit", async () => {
    const f = fakeProcess();
    const client = await attachControl("s", { spawn: () => f.proc, resolvePane: async () => "%1" });
    const reasons: string[] = [];
    client!.onExit((r) => reasons.push(r));
    f.push("%exit server exited\n");
    await settle();
    expect(reasons).toEqual(["server exited"]);
  });

  test("reports the stream ending as an exit", async () => {
    const f = fakeProcess();
    const client = await attachControl("s", { spawn: () => f.proc, resolvePane: async () => "%1" });
    const reasons: string[] = [];
    client!.onExit((r) => reasons.push(r));
    f.endStream();
    await settle();
    expect(reasons).toEqual(["control stream ended"]);
  });

  test("exits only once", async () => {
    const f = fakeProcess();
    const client = await attachControl("s", { spawn: () => f.proc, resolvePane: async () => "%1" });
    let calls = 0;
    client!.onExit(() => {
      calls += 1;
    });
    f.push("%exit\n");
    f.endStream();
    await settle();
    expect(calls).toBe(1);
  });

  test("clamps the size it reports to tmux", async () => {
    const f = fakeProcess();
    const client = await attachControl("s", { spawn: () => f.proc, resolvePane: async () => "%1" });
    client!.resize(120, 40);
    client!.resize(0, 0);
    client!.resize(9999, 9999);
    client!.resize(NaN, 10);
    expect(f.written).toEqual([
      "refresh-client -C 120x40\n",
      "refresh-client -C 20x5\n",
      "refresh-client -C 500x200\n",
    ]);
    client!.close();
  });

  test("detaches rather than only killing", async () => {
    const f = fakeProcess();
    const client = await attachControl("s", { spawn: () => f.proc, resolvePane: async () => "%1" });
    client!.close();
    expect(f.written).toContain("detach-client\n");
    expect(f.killed()).toBe(true);
  });

  test("sends nothing after close", async () => {
    const f = fakeProcess();
    const client = await attachControl("s", { spawn: () => f.proc, resolvePane: async () => "%1" });
    client!.close();
    const after = f.written.length;
    client!.send("kill-session");
    client!.resize(80, 24);
    expect(f.written.length).toBe(after);
  });

  test("returns null when tmux cannot be spawned", async () => {
    const client = await attachControl("s", {
      spawn: () => {
        throw new Error("no tmux");
      },
    });
    expect(client).toBeNull();
  });

  test("forwards output that arrives before the pane id resolves", async () => {
    const f = fakeProcess();
    /* The id lands one tick late, which is when a real session's first output
       tends to arrive. Dropping it would leave the terminal blank. */
    const client = await attachControl("s", {
      spawn: () => f.proc,
      resolvePane: () => new Promise((res) => setTimeout(() => res("%1"), 30)),
    });
    const seen: string[] = [];
    client!.onOutput((d) => seen.push(text(d)));
    client!.dropBuffered();
    f.push("%output %1 early\n");
    await settle();
    expect(seen).toEqual(["early"]);
    client!.close();
  });
});
