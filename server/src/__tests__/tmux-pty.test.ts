import { describe, expect, test } from "bun:test";
import {
  attachPty,
  configurePtySession,
  measurePtySession,
  pinPtyWindow,
  releasePtyWindow,
  queuePtyScroll,
  cancelPtyScroll,
  scrollPtySession,
  settlePtyWindow,
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
function tmuxStub() {
  const args: string[][] = [];
  return {
    args,
    run: (next: string[]) => {
      args.push(next);
      return { exitCode: 0 };
    },
  };
}

const stub = (spawn: SpawnPty) => ({
  spawn,
  configure: () => true,
  measure: () => null,
  run: tmuxStub().run,
});

describe("attachPty", () => {
  test("spawns the requested session at a safe initial size", () => {
    const fake = fakePty();
    const client = attachPty("claude-one", {
      spawn: fake.spawn,
      configure: () => true,
      run: tmuxStub().run,
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
        run: tmuxStub().run,
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
      run: tmuxStub().run,
      measure: () => ({ cols: 200, rows: 50 }),
    });

    expect(fake.options()?.cols).toBe(200);
    expect(fake.options()?.rows).toBe(50);
    client?.close();
  });

  test("attaches at the caller's size, which wins over the window's", () => {
    const fake = fakePty();
    const client = attachPty("s", {
      spawn: fake.spawn,
      configure: () => true,
      run: tmuxStub().run,
      measure: () => ({ cols: 200, rows: 50 }),
      cols: 120,
      rows: 40,
    });

    expect(fake.options()?.cols).toBe(120);
    expect(fake.options()?.rows).toBe(40);
    client?.close();
  });

  /* Resizing a window makes the agent inside it redraw, so a window that is
     already the right size must be left alone. settlePtyWindow has normally
     moved it before the attach, which is exactly this case. */
  test("does not touch a window that already has the client's size", () => {
    const fake = fakePty();
    const tmux = tmuxStub();
    const client = attachPty("s", {
      spawn: fake.spawn,
      configure: () => true,
      run: tmux.run,
      measure: () => ({ cols: 120, rows: 40 }),
      cols: 120,
      rows: 40,
    })!;

    expect(tmux.args.filter((a) => a[1] === "resize-window")).toEqual([]);
    client.close();
  });

  /* Another viewer of the same session — iTerm, a phone, a second tab — used to
     resize the window under this one, and tmux then filled the part of the grid
     the window no longer covered with dots. */
  test("holds the window at this client's size while it is attached", () => {
    const fake = fakePty();
    const tmux = tmuxStub();
    const client = attachPty("claude-one", {
      spawn: fake.spawn,
      configure: () => true,
      run: tmux.run,
      cols: 120,
      rows: 40,
    })!;

    expect(tmux.args).toEqual([
      ["tmux", "resize-window", "-t", "claude-one", "-x", "120", "-y", "40"],
    ]);
    client.close();
  });

  test("moves the pin when the browser changes shape, and not when it does not", () => {
    const fake = fakePty();
    const tmux = tmuxStub();
    const client = attachPty("s", {
      spawn: fake.spawn,
      configure: () => true,
      run: tmux.run,
      cols: 120,
      rows: 40,
    })!;

    client.resize(120, 40);
    client.resize(100, 30);
    client.resize(100.4, 30.2);

    expect(tmux.args.filter((a) => a[1] === "resize-window")).toEqual([
      ["tmux", "resize-window", "-t", "s", "-x", "120", "-y", "40"],
      ["tmux", "resize-window", "-t", "s", "-x", "100", "-y", "30"],
    ]);
    /* The PTY is left alone too. A client repeats its grid on every connect and
       every resize observation, and each ioctl signals the tmux client for
       nothing. */
    expect(fake.sizes).toEqual([[100, 30]]);
    client.close();
  });

  test("gives the size back to tmux when the browser goes away", () => {
    const fake = fakePty();
    const tmux = tmuxStub();
    const client = attachPty("s", {
      spawn: fake.spawn,
      configure: () => true,
      run: tmux.run,
      cols: 120,
      rows: 40,
    })!;
    client.close();

    expect(tmux.args.at(-1)).toEqual([
      "tmux", "set-option", "-t", "s", "default-size", "120x40",
    ]);
  });

  test("a pin does not outlive a client that exited on its own", async () => {
    const fake = fakePty();
    const tmux = tmuxStub();
    attachPty("s", {
      spawn: fake.spawn,
      configure: () => true,
      run: tmux.run,
      cols: 120,
      rows: 40,
    })!;

    fake.finish(0);
    await settle();

    expect(tmux.args.at(-1)).toEqual([
      "tmux", "set-option", "-t", "s", "default-size", "120x40",
    ]);
  });
});

describe("settlePtyWindow", () => {
  /** tmux reads: window size first, then repeated pane captures. */
  function tmuxReads(size: string, panes: string[]) {
    const args: string[][] = [];
    let capture = 0;
    return {
      args,
      captures: () => capture,
      read: (next: string[]) => {
        args.push(next);
        if (next[1] === "capture-pane") {
          const text = panes[Math.min(capture, panes.length - 1)]!;
          capture++;
          return { exitCode: 0, stdout: text };
        }
        return { exitCode: 0, stdout: size };
      },
    };
  }

  const nap = () => Promise.resolve();

  test("leaves a window that already has the browser's size alone", async () => {
    const reads = tmuxReads("120 40", ["screen"]);
    const tmux = tmuxStub();

    const moved = await settlePtyWindow(
      "s",
      { cols: 120, rows: 40 },
      { read: reads.read, run: tmux.run, sleep: nap },
    );

    expect(moved).toBe(false);
    expect(tmux.args).toEqual([]);
    expect(reads.captures()).toBe(0);
  });

  /* The point of the wait: the redraw a resize provokes happens here, with no
     PTY attached, so the browser's first paint is of the finished screen. */
  test("resizes, then waits for the pane to stop changing", async () => {
    const reads = tmuxReads("80 24", ["one", "two", "three", "done", "done", "done"]);
    const tmux = tmuxStub();

    const moved = await settlePtyWindow(
      "s",
      { cols: 120, rows: 40 },
      { read: reads.read, run: tmux.run, sleep: nap },
    );

    expect(moved).toBe(true);
    expect(tmux.args).toEqual([
      ["tmux", "resize-window", "-t", "s", "-x", "120", "-y", "40"],
    ]);
    // First capture, then one per poll until two matched: "done" twice over.
    expect(reads.captures()).toBe(6);
  });

  /* An agent mid-answer rewrites the pane forever, and the reader is owed a
     terminal either way. */
  test("gives up on a pane that never settles", async () => {
    let frame = 0;
    let clock = 0;
    const read = (next: string[]) =>
      next[1] === "capture-pane"
        ? { exitCode: 0, stdout: `frame ${frame++}` }
        : { exitCode: 0, stdout: "80 24" };

    expect(
      await settlePtyWindow(
        "s",
        { cols: 120, rows: 40 },
        {
          read,
          run: () => ({ exitCode: 0 }),
          sleep: async (ms) => {
            clock += ms;
          },
          now: () => clock,
        },
      ),
    ).toBe(true);
    // Polled until the cap rather than forever.
    expect(frame).toBeGreaterThan(5);
    expect(clock).toBeLessThanOrEqual(1300);
  });

  test("does nothing without a size to move to", async () => {
    const tmux = tmuxStub();
    expect(await settlePtyWindow("s", undefined, { run: tmux.run, sleep: nap })).toBe(false);
    expect(tmux.args).toEqual([]);
  });
});

describe("pinPtyWindow and releasePtyWindow", () => {
  test("pinning asks tmux for exactly the client's grid", () => {
    const tmux = tmuxStub();
    expect(pinPtyWindow("claude-one", { cols: 200, rows: 50 }, tmux.run)).toBe(true);
    expect(tmux.args[0]).toEqual([
      "tmux", "resize-window", "-t", "claude-one", "-x", "200", "-y", "50",
    ]);
  });

  /* Stay manual: handing size back to `latest` made the next iTerm or
     `tmux attach` SIGWINCH the agent. The browser grid is still stored as
     default-size so a session with no clients does not snap to 80x24. */
  test("releasing keeps the window pinned and stores the browser's grid as default", () => {
    const tmux = tmuxStub();
    expect(releasePtyWindow("claude-one", { cols: 120, rows: 40 }, tmux.run)).toBe(true);
    expect(tmux.args).toEqual([
      ["tmux", "set-option", "-t", "claude-one", "default-size", "120x40"],
    ]);
  });

  test("reports a refusal, which is how a session that has gone arrives", () => {
    expect(pinPtyWindow("gone", { cols: 80, rows: 24 }, () => ({ exitCode: 1 }))).toBe(false);
    expect(releasePtyWindow("gone", undefined, () => ({ exitCode: 1 }))).toBe(false);
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
  /* Mouse mode is turned off rather than left alone: with it on, a drag becomes
     a tmux selection that cancels itself on release, taking the reader's
     selection with it. */
  test("hides tmux status and leaves the mouse to the browser", () => {
    const commands: string[][] = [];
    const ok = configurePtySession("claude-one", (args) => {
      commands.push(args);
      return { exitCode: 0 };
    });

    expect(ok).toBe(true);
    expect(commands).toEqual([
      ["tmux", "set-option", "-t", "claude-one", "status", "off"],
      ["tmux", "set-option", "-t", "claude-one", "mouse", "off"],
      ["tmux", "set-option", "-w", "-t", "claude-one", "window-size", "manual"],
      ["tmux", "set-option", "-t", "claude-one", "fill-character", " "],
    ]);
  });

  test("stops when a session option cannot be applied", () => {
    let calls = 0;
    expect(configurePtySession("missing", () => ({ exitCode: ++calls === 1 ? 1 : 0 }))).toBe(false);
    expect(calls).toBe(1);
  });

  /* fill-character only exists from tmux 3.4, and an older tmux must still get
     a working terminal — the dots it fills with are a blemish, not a fault. */
  test("a tmux without a fill character still gets a terminal", () => {
    const ok = configurePtySession("claude-one", (args) => ({
      exitCode: args.includes("fill-character") ? 1 : 0,
    }));
    expect(ok).toBe(true);
  });
});

describe("scrollPtySession", () => {
  const capture = () => {
    const args: string[][] = [];
    return {
      args,
      run: (next: string[]) => {
        args.push(next);
        return { exitCode: 0 };
      },
    };
  };

  test("going back enters copy mode, so there is a view to move", () => {
    const { args, run } = capture();
    expect(scrollPtySession("claude-one", 3, run)).toBe(true);
    expect(args).toEqual([[
      "tmux", "copy-mode", "-e", "-t", "claude-one",
      ";", "send-keys", "-X", "-N", "3", "-t", "claude-one", "scroll-up",
    ]]);
  });

  /* Entering copy mode to scroll forward would jump the view to the bottom,
     which is the opposite of what was asked for. */
  test("returning toward the prompt does not enter copy mode", () => {
    const { args, run } = capture();
    expect(scrollPtySession("claude-one", -2, run)).toBe(true);
    expect(args).toEqual([[
      "tmux", "send-keys", "-X", "-N", "2", "-t", "claude-one", "scroll-down",
    ]]);
  });

  test("caps the count so one flick cannot walk the whole history", () => {
    const { args, run } = capture();
    scrollPtySession("s", 5000, run);
    expect(args[0]).toContain("40");
  });

  test("asks tmux for nothing when there is nothing to move", () => {
    const { args, run } = capture();
    expect(scrollPtySession("s", 0, run)).toBe(false);
    expect(scrollPtySession("s", 0.2, run)).toBe(false);
    expect(scrollPtySession("s", Number.NaN, run)).toBe(false);
    expect(args).toEqual([]);
  });

  test("reports a refusal, which is how scrolling past the end arrives", () => {
    expect(scrollPtySession("s", -1, () => ({ exitCode: 1 }))).toBe(false);
  });
});

describe("queuePtyScroll", () => {
  const capture = () => {
    const args: string[][] = [];
    const queued: Array<() => void> = [];
    return {
      args,
      run: (next: string[]) => {
        args.push(next);
        return { exitCode: 0 };
      },
      schedule: (fn: () => void) => {
        queued.push(fn);
        return queued.length;
      },
      cancel: () => {},
      flush: () => {
        const fn = queued.shift();
        fn?.();
      },
    };
  };

  test("merges rapid ticks into one tmux call", () => {
    const { args, run, schedule, cancel, flush } = capture();
    queuePtyScroll("claude-one", 3, run, schedule, cancel);
    queuePtyScroll("claude-one", 2, run, schedule, cancel);
    expect(args).toEqual([]);
    flush();
    expect(args).toEqual([[
      "tmux", "copy-mode", "-e", "-t", "claude-one",
      ";", "send-keys", "-X", "-N", "5", "-t", "claude-one", "scroll-up",
    ]]);
  });

  test("keeps opposite directions from cancelling across a flush", () => {
    const { args, run, schedule, cancel, flush } = capture();
    queuePtyScroll("claude-one", 4, run, schedule, cancel);
    flush();
    queuePtyScroll("claude-one", -2, run, schedule, cancel);
    flush();
    expect(args).toEqual([
      [
        "tmux", "copy-mode", "-e", "-t", "claude-one",
        ";", "send-keys", "-X", "-N", "4", "-t", "claude-one", "scroll-up",
      ],
      ["tmux", "send-keys", "-X", "-N", "2", "-t", "claude-one", "scroll-down"],
    ]);
  });

  test("drops a queued tick when the socket closes", () => {
    const { args, run, schedule, cancel, flush } = capture();
    queuePtyScroll("claude-one", 3, run, schedule, cancel);
    cancelPtyScroll("claude-one", cancel);
    flush();
    expect(args).toEqual([]);
  });
});
