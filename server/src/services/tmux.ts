import { spawnTool } from "./spawn";

const decoder = new TextDecoder();

async function run(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const proc = spawnTool("tmux", args, {
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

export interface PaneTargetOptions {
  target?: string;
  preferredCommands?: string[];
  preferredPaths?: string[];
}

interface TmuxPane {
  id: string;
  command: string;
  active: boolean;
  title: string;
  path: string;
}

// tmux 3.5+ converts \t to _ in -F format strings, so use a multi-char delimiter
const LIST_SEP = "|||";
const AGENT_COMMANDS = new Set(["claude", "codex", "agent"]);
const DASHBOARD_COMMANDS = new Set(["workmux"]);
const AGENT_TITLE_RE = /\b(action required|claude|codex|cursor|agentdock)\b/i;
const AGENT_PANE_TITLE_RE = /\b(action required|claude|codex|cursor)\b/i;

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

function normalizeCommand(command: string): string {
  return (command.trim().split("/").pop() || "").toLowerCase();
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, "");
}

async function listPanes(name: string): Promise<TmuxPane[]> {
  const fmt = [
    "#{pane_id}",
    "#{pane_current_command}",
    "#{pane_active}",
    "#{pane_title}",
    "#{pane_current_path}",
  ].join(LIST_SEP);
  const { stdout, exitCode } = await run(["list-panes", "-t", `=${name}`, "-F", fmt]);
  if (exitCode !== 0) return [];

  const panes: TmuxPane[] = [];
  for (const line of stdout.trim().split("\n")) {
    if (!line) continue;
    const [id, command, active, title, ...rest] = line.split(LIST_SEP);
    panes.push({
      id,
      command: normalizeCommand(command || ""),
      active: active === "1",
      title: title || "",
      path: rest.join(LIST_SEP),
    });
  }
  return panes;
}

/** A pane anywhere on the tmux server, with the coordinates needed to address it. */
export interface TmuxPaneRef extends TmuxPane {
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
}

/** True when the pane is running a coding agent rather than a shell or dashboard. */
export function isAgentCommand(command: string): boolean {
  return AGENT_COMMANDS.has(normalizeCommand(command));
}

export async function sessionHasAgentPane(name: string): Promise<boolean> {
  const panes = await listPanes(name);
  return panes.some((pane) => isAgentCommand(pane.command) || AGENT_PANE_TITLE_RE.test(pane.title));
}

/**
 * Every pane on the tmux server, not just those in one session.
 *
 * listPanes() is scoped to a session because Agentdock's own agents each own one.
 * Finding agents it did not launch has to start from the panes themselves — they
 * live inside sessions it knows nothing about.
 */
export async function listAllPanes(): Promise<TmuxPaneRef[]> {
  const fmt = [
    "#{pane_id}",
    "#{session_name}",
    "#{window_index}",
    "#{pane_index}",
    "#{pane_current_command}",
    "#{pane_active}",
    "#{pane_title}",
    "#{pane_current_path}",
  ].join(LIST_SEP);
  const { stdout, exitCode } = await run(["list-panes", "-a", "-F", fmt]);
  if (exitCode !== 0) return [];

  const panes: TmuxPaneRef[] = [];
  for (const line of stdout.trim().split("\n")) {
    if (!line) continue;
    const [id, sessionName, windowIndex, paneIndex, command, active, title, ...rest] =
      line.split(LIST_SEP);
    panes.push({
      id,
      sessionName,
      windowIndex: parseInt(windowIndex, 10),
      paneIndex: parseInt(paneIndex, 10),
      command: normalizeCommand(command || ""),
      active: active === "1",
      title: title || "",
      path: rest.join(LIST_SEP),
    });
  }
  return panes;
}

/**
 * Whether a pane id (e.g. "%44") still refers to a live pane.
 *
 * Uses list-panes rather than display-message: display-message silently falls back
 * to the current pane when the target is gone, exiting 0 and reporting a live pane
 * that is not the one asked about. list-panes fails with "can't find pane".
 */
export async function hasPane(paneId: string): Promise<boolean> {
  const { exitCode } = await run(["list-panes", "-t", paneId, "-F", "#{pane_id}"]);
  return exitCode === 0;
}

export async function resolvePaneTarget(
  name: string,
  options: PaneTargetOptions = {},
): Promise<string> {
  if (options.target) return options.target;

  const panes = await listPanes(name);
  if (panes.length === 0) return name;
  if (panes.length === 1) return panes[0].id || name;

  const preferredCommands = new Set(
    (options.preferredCommands ?? []).map(normalizeCommand).filter(Boolean),
  );
  const preferredPaths = new Set(
    (options.preferredPaths ?? []).map(normalizePath).filter(Boolean),
  );
  const isDashboardPane = (pane: TmuxPane) => DASHBOARD_COMMANDS.has(pane.command);
  const usablePanes = panes.filter((pane) => !isDashboardPane(pane));

  const preferred = usablePanes.find((pane) => preferredCommands.has(pane.command));
  if (preferred) return preferred.id;

  const knownAgent = usablePanes.find((pane) => AGENT_COMMANDS.has(pane.command));
  if (knownAgent) return knownAgent.id;

  const pathMatch = usablePanes.find((pane) => preferredPaths.has(normalizePath(pane.path)));
  if (pathMatch) return pathMatch.id;

  const titledAgent = usablePanes.find((pane) => AGENT_TITLE_RE.test(pane.title));
  if (titledAgent) return titledAgent.id;

  const activePane = panes.find((pane) => pane.active);
  if (activePane && isDashboardPane(activePane) && usablePanes.length === 1) {
    return usablePanes[0].id;
  }

  return name;
}

export async function createSession(
  name: string,
  cwd: string,
  env?: Record<string, string>,
  command?: string,
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
  if (command) {
    args.push(command);
  }
  // NO_COLOR convention: variable's *presence* (even empty) disables colors.
  // Use -gr to globally mark it for removal from child processes, BEFORE the session shell spawns.
  await run(["set-environment", "-g", "-r", "NO_COLOR"]);
  // Enable 24-bit true color passthrough
  await run(["set-option", "-g", "-a", "terminal-overrides", ",*:Tc"]);

  if (command) {
    // remain-on-exit=failed keeps the pane (and so the session) alive when the
    // command exits non-zero, leaving the error on screen — an agent that is not
    // on PATH exits 127 the instant it starts, and without this the session is
    // gone before anyone can read why. A clean exit still closes the pane.
    //
    // Chained into the same tmux invocation on purpose: as two calls, a fast
    // failure beats the set-option and the session is already gone.
    const chained = [...args, ";", "set-option", "-t", name, "remain-on-exit", "failed"];
    const res = await run(chained);
    if (res.exitCode === 0) return;
    // "failed" is tmux 3.4+. On older tmux the whole chain is rejected, so fall
    // back to creating the session without it rather than not creating it.
  }
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

export async function sendKeysRaw(
  name: string,
  keys: string,
  options?: PaneTargetOptions,
): Promise<void> {
  const target = await resolvePaneTarget(name, options);
  // Single-line short text: send-keys -l is fine
  if (keys.length <= 400 && !keys.includes("\n")) {
    await run(["send-keys", "-l", "-t", target, keys]);
    return;
  }
  // Multi-line or large text: use tmux load-buffer + paste-buffer.
  // -p enables bracketed paste mode (\033[200~...\033[201~) so the receiving
  // application treats newlines as literal newlines, not Enter key presses.
  const tmp = `/tmp/agentdock-paste-${Date.now()}`;
  await Bun.write(tmp, keys);
  try {
    await run(["load-buffer", tmp]);
    await run(["paste-buffer", "-p", "-t", target, "-d"]);
  } finally {
    try { const { unlink } = require("fs/promises"); await unlink(tmp); } catch {}
  }
}

export async function sendSpecialKey(
  name: string,
  key: string,
  options?: PaneTargetOptions,
): Promise<void> {
  const target = await resolvePaneTarget(name, options);
  await run(["send-keys", "-t", target, key]);
}

export async function resizePane(
  name: string,
  cols: number,
  rows: number,
  _options?: PaneTargetOptions,
): Promise<void> {
  // Resize the tmux window to match the browser terminal dimensions.
  await run(["resize-window", "-t", name, "-x", String(cols), "-y", String(rows)]);
}

export interface PaneSnapshot {
  content: string;
  cursorX: number;
  cursorY: number;
  paneHeight: number;
  scrollPosition: number;
  command: string;
  title: string;
}

export async function capturePaneSnapshot(
  name: string,
  options?: PaneTargetOptions,
): Promise<{ ok: true; data: PaneSnapshot } | { ok: false; error: string }> {
  const target = await resolvePaneTarget(name, options);

  // Get cursor position and pane info
  const infoFmt = [
    "#{cursor_x}",
    "#{cursor_y}",
    "#{pane_height}",
    "#{history_size}",
    "#{pane_current_command}",
    "#{pane_title}",
  ].join(LIST_SEP);
  const info = await run([
    "display-message",
    "-p",
    "-t",
    target,
    infoFmt,
  ]);
  if (info.exitCode !== 0) {
    console.error(`[tmux] display-message failed for "${name}": ${info.stderr.trim()}`);
    return { ok: false, error: info.stderr.trim() || `exit code ${info.exitCode}` };
  }

  const parts = info.stdout.trim().split(LIST_SEP);
  const [cursorX, cursorY, paneHeight, historySize] = parts.slice(0, 4).map(Number);
  const command = parts[4] ?? "";
  const title = parts.slice(5).join(LIST_SEP);

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
    target,
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
      title,
    },
  };
}
