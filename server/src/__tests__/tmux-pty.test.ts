import { describe, expect, test } from "bun:test";
import {
  attachPty,
  configurePtySession,
  measurePtySession,
  type PtyProcess,
  type PtySpawnOptions,
  type PtyTerminal,
  type SpawnPty,
} from "../services/tmux-pty";

function fakePty() {
  const writes: string[] = [];
  const sizes: Array<[number, number]> = [];
  let closed = false;
  let killed = false;
  let finish: (code: number) => void = () => {};
  let options: PtySpawnOptions | null = null;
  let session = "";

  const terminal: PtyTerminal = {
    write(data) {
      writes.push(typeof data === "string" ? data : "<binary>");
      return typeof data === "string" ? data.length : data.byteLength;
    },
    resize(cols, rows) {
      sizes.push([cols, rows]);
    },
    close() {
      closed = true;
    },
  };

  const process: PtyProcess = {
    terminal,
    exited: new Promise<number>((resolve) => {
      finish = resolve;
    }),
    kill() {
      killed = true;
    },
  };

  return {
    spawn(nextSession: string, nextOptions: PtySpawnOptions) {
      session = nextSession;
      options = nextOptions;
      return process;
    },
    emit(data: string) {
      options?.onData(new TextEncoder().encode(data));
    },
    finish,
    writes,
    sizes,
    session: () => session,
    options: () => options,
    closed: () => closed,
    killed: () => killed,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Injected tmux calls, so no test shells out to a session that is not there. */
const stub = (spawn: SpawnPty) => ({ spawn, configure: () => true, measure: () => null });

describe("attachPty", () => {
  test("spawns the requested session at a safe initial size", () => {
    const fake = fakePty();
    const client = attachPty("claude-one", {
      spawn: fake.spawn,
      configure: () => true,
      cols: 2,
      rows: 999,
    });

    expect(client).not.toBeNull();
    expect(fake.session()).toBe("claude-one");
    expect(fake.options()?.cols).toBe(20);
    expect(fake.options()?.rows).toBe(200);
    client?.close();
  });

  test("buffers startup bytes and flushes them exactly once", () => {
    const fake = fakePty();
    const client = attachPty("s", stub(fake.spawn))!;
    const seen: string[] = [];

    fake.emit("\x1b[Hfirst");
    client.onOutput((data) => seen.push(new TextDecoder().decode(data)));
    fake.emit("\rsecond");

    expect(seen).toEqual(["\x1b[Hfirst", "\rsecond"]);
    client.close();
  });

  test("writes input directly and clamps resizes", () => {
    const fake = fakePty();
    const client = attachPty("s", stub(fake.spawn))!;

    client.write("a\r\x1b[A");
    client.resize(120.4, 40.6);
    client.resize(0, 9999);
    client.resize(Number.NaN, 20);

    expect(fake.writes).toEqual(["a\r\x1b[A"]);
    expect(fake.sizes).toEqual([[120, 41], [20, 200]]);
    client.close();
  });

  test("reports process exit and only closes once", async () => {
    const fake = fakePty();
    const client = attachPty("s", stub(fake.spawn))!;
    const reasons: string[] = [];
    client.onExit((reason) => reasons.push(reason));

    fake.finish(1);
    await settle();
    client.close();

    expect(reasons).toEqual(["tmux exited (1)"]);
    expect(fake.closed()).toBe(false);
    expect(fake.killed()).toBe(false);
  });

  test("detach closes the PTY and kills only the attached client", () => {
    const fake = fakePty();
    const client = attachPty("s", stub(fake.spawn))!;
    client.close();
    client.close();

    expect(fake.closed()).toBe(true);
    expect(fake.killed()).toBe(true);
  });

  test("returns null when PTY spawning fails", () => {
    expect(
      attachPty(
        "s",
        stub(() => {
          throw new Error("no PTY");
        }),
      ),
    ).toBeNull();
  });

  test("does not spawn when the tmux viewer options cannot be configured", () => {
    let spawned = false;
    expect(
      attachPty("s", {
        configure: () => false,
        measure: () => null,
        spawn: () => {
          spawned = true;
          throw new Error("should not run");
        },
      }),
    ).toBeNull();
    expect(spawned).toBe(false);
  });

  /* Attaching sets the tmux window size. A caller that has not measured its own
     grid yet must not shrink the window to a guess and repaint it for everyone
     already watching. */
  test("attaches at the session's own size when no size is given", () => {
    const fake = fakePty();
    const client = attachPty("s", {
      spawn: fake.spawn,
      configure: () => true,
      measure: () => ({ cols: 200, rows: 50 }),
    });

    expect(fake.options()?.cols).toBe(200);
    expect(fake.options()?.rows).toBe(50);
    client?.close();
  });

  test("does not measure when the caller supplies a size", () => {
    const fake = fakePty();
    let measured = false;
    const client = attachPty("s", {
      spawn: fake.spawn,
      configure: () => true,
      measure: () => {
        measured = true;
        return { cols: 200, rows: 50 };
      },
      cols: 120,
      rows: 40,
    });

    expect(measured).toBe(false);
    expect(fake.options()?.cols).toBe(120);
    client?.close();
  });
});

describe("measurePtySession", () => {
  test("reads the window size tmux is drawing at", () => {
    const args: string[][] = [];
    const size = measurePtySession("claude-one", (next) => {
      args.push(next);
      return { exitCode: 0, stdout: "200 50\n" };
    });

    expect(size).toEqual({ cols: 200, rows: 50 });
    expect(args[0]).toEqual([
      "tmux",
      "display-message",
      "-p",
      "-t",
      "claude-one",
      "#{window_width} #{window_height}",
    ]);
  });

  test("reports no size for a missing session or unreadable output", () => {
    expect(measurePtySession("gone", () => ({ exitCode: 1, stdout: "" }))).toBeNull();
    expect(measurePtySession("odd", () => ({ exitCode: 0, stdout: "wide tall\n" }))).toBeNull();
  });
});

describe("configurePtySession", () => {
  test("hides tmux status and enables mouse scrolling", () => {
    const commands: string[][] = [];
    const ok = configurePtySession("claude-one", (args) => {
      commands.push(args);
      return { exitCode: 0 };
    });

    expect(ok).toBe(true);
    expect(commands).toEqual([
      ["tmux", "set-option", "-t", "claude-one", "status", "off"],
      ["tmux", "set-option", "-t", "claude-one", "mouse", "on"],
    ]);
  });

  test("stops when a session option cannot be applied", () => {
    let calls = 0;
    expect(configurePtySession("missing", () => ({ exitCode: ++calls === 1 ? 1 : 0 }))).toBe(false);
    expect(calls).toBe(1);
  });
});
