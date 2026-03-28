const decoder = new TextDecoder();

async function run(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const proc = Bun.spawn(["tmux", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.errno === -2) {
      throw new Error(
        "tmux is not installed. Install it with:\n  macOS: brew install tmux\n  Linux: sudo apt install tmux  (or sudo dnf install tmux)"
      );
    }
    throw err;
  }
}

export interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
  created: number;
  path: string;
}

// tmux 3.5+ converts \t to _ in -F format strings, so use a multi-char delimiter
const LIST_SEP = "|||";

export async function listSessions(
  prefix?: string,
): Promise<TmuxSession[]> {
  const fmt = [
    "#{session_name}",
    "#{session_windows}",
    "#{session_attached}",
    "#{session_created}",
    "#{session_path}",
  ].join(LIST_SEP);
  const { stdout, exitCode } = await run(["list-sessions", "-F", fmt]);
  if (exitCode !== 0) return [];
  const sessions: TmuxSession[] = [];
  for (const line of stdout.trim().split("\n")) {
    if (!line) continue;
    const [name, windows, attached, created, ...rest] = line.split(LIST_SEP);
    const path = rest.join(LIST_SEP); // path may theoretically contain |||
    if (prefix && !name.startsWith(prefix + "-")) continue;
    sessions.push({
      name,
      windows: parseInt(windows, 10),
      attached: attached === "1",
      created: parseInt(created, 10),
      path: path || "",
    });
  }
  return sessions;
}

export async function hasSession(name: string): Promise<boolean> {
  const { exitCode } = await run(["has-session", "-t", `=${name}`]);
  return exitCode === 0;
}

export async function createSession(
  name: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<void> {
  const args = ["new-session", "-d", "-s", name, "-c", cwd,
    "-e", "COLORTERM=truecolor", // enable 24-bit color support
    "-e", "FORCE_COLOR=3",       // force chalk/supports-color to use true color (level 3)
  ];
  if (env) {
    for (const [k, v] of Object.entries(env)) {
      args.push("-e", `${k}=${v}`);
    }
  }
  // NO_COLOR convention: variable's *presence* (even empty) disables colors.
  // Use -gr to globally mark it for removal from child processes, BEFORE the session shell spawns.
  await run(["set-environment", "-g", "-r", "NO_COLOR"]);
  // Enable 24-bit true color passthrough
  await run(["set-option", "-g", "-a", "terminal-overrides", ",*:Tc"]);
  await run(args);
}

export async function killSession(name: string): Promise<void> {
  await run(["kill-session", "-t", `=${name}`]);
}

export async function setOption(
  name: string,
  option: string,
  value: string,
): Promise<void> {
  await run(["set-option", "-t", name, option, value]);
}

export async function setEnvironment(
  name: string,
  key: string,
  value: string,
): Promise<void> {
  await run(["set-environment", "-t", name, key, value]);
}

export async function sendKeys(
  name: string,
  text: string,
): Promise<void> {
  await run(["send-keys", "-t", name, text, "Enter"]);
}

export async function sendKeysRaw(
  name: string,
  keys: string,
): Promise<void> {
  if (keys.length <= 400) {
    await run(["send-keys", "-l", "-t", name, keys]);
    return;
  }
  // Large text: use tmux load-buffer + paste-buffer (no length limit, atomic)
  const tmp = `/tmp/agentdock-paste-${Date.now()}`;
  await Bun.write(tmp, keys);
  try {
    await run(["load-buffer", tmp]);
    await run(["paste-buffer", "-t", name, "-d"]);
  } finally {
    try { const { unlink } = require("fs/promises"); await unlink(tmp); } catch {}
  }
}

export async function sendSpecialKey(
  name: string,
  key: string,
): Promise<void> {
  await run(["send-keys", "-t", name, key]);
}

export async function resizePane(
  name: string,
  cols: number,
  rows: number,
): Promise<void> {
  // Resize the tmux window to match the browser terminal dimensions
  await run(["resize-window", "-t", name, "-x", String(cols), "-y", String(rows)]);
}

export interface PaneSnapshot {
  content: string;
  cursorX: number;
  cursorY: number;
  paneHeight: number;
  scrollPosition: number;
  command: string;
}

export async function capturePaneSnapshot(
  name: string,
): Promise<{ ok: true; data: PaneSnapshot } | { ok: false; error: string }> {
  // Get cursor position and pane info
  const info = await run([
    "display-message",
    "-p",
    "-t",
    name,
    "#{cursor_x},#{cursor_y},#{pane_height},#{history_size},#{pane_current_command}",
  ]);
  if (info.exitCode !== 0) {
    console.error(`[tmux] display-message failed for "${name}": ${info.stderr.trim()}`);
    return { ok: false, error: info.stderr.trim() || `exit code ${info.exitCode}` };
  }

  const parts = info.stdout.trim().split(",");
  const [cursorX, cursorY, paneHeight, historySize] = parts.slice(0, 4).map(Number);
  const command = parts.slice(4).join(",");

  // -S -200: capture visible pane + 200 lines of scrollback (not full history)
  // Full history (-S -) grows unbounded and causes massive memory usage over time
  const { stdout, stderr, exitCode } = await run([
    "capture-pane",
    "-p",
    "-e",
    "-J",
    "-S",
    "-200",
    "-t",
    name,
  ]);
  if (exitCode !== 0) {
    console.error(`[tmux] capture-pane failed for "${name}": exit=${exitCode} stderr=${stderr.trim()}`);
    return { ok: false, error: stderr.trim() || `exit code ${exitCode}` };
  }
  return {
    ok: true,
    data: {
      content: stdout,
      cursorX,
      cursorY,
      paneHeight,
      scrollPosition: historySize,
      command,
    },
  };
}
