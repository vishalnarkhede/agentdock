/**
 * Plain shells beside an agent.
 *
 * Sometimes you just want to run a command in the worktree the agent is working
 * in — check a file, run a test, look at git — without typing it into the
 * agent's prompt and without leaving the session.
 *
 * They are real tmux sessions, so they survive a reload exactly as the agent's
 * does, and everything that already streams a pane works on them unchanged. The
 * name is what keeps them out of the way: the session list only ever asks tmux
 * for names starting with the agent prefix, so a shell named `shell-…` is
 * invisible to it while still being a first-class session to tmux.
 */

import * as tmux from "./tmux";
import { getSessionMeta, getPreferences, PREFIX } from "./config";

/** Two is the limit: past that the panes are too small to be worth having. */
export const MAX_SHELLS = 2;

const SHELL_PREFIX = "shell";

/** The tmux name of the nth shell belonging to a session. */
export function shellName(sessionName: string, index: number): string {
  const base = sessionName.startsWith(`${PREFIX}-`)
    ? sessionName.slice(PREFIX.length + 1)
    : sessionName;
  return `${SHELL_PREFIX}-${base.replace(/[^a-zA-Z0-9_-]/g, "-")}-${index}`;
}

/**
 * Where a shell should open: the same worktree the agent is in.
 *
 * A multi-repo session has several, and the primary repo is the one the reader
 * thinks of as "this session" — the same choice the agent's own cwd makes.
 */
export function shellCwd(sessionName: string, fallback?: string): string | null {
  const metas = getSessionMeta(sessionName);
  if (metas.length === 0) return fallback ?? null;
  const primary = getPreferences().primaryRepo;
  if (primary) {
    const match = metas.find((m) => m.repoPath.split("/").filter(Boolean).pop() === primary);
    if (match) return match.wtDir;
  }
  return metas[0].wtDir;
}

/** Which of a session's shells are currently alive, in order. */
export async function listShells(sessionName: string): Promise<string[]> {
  const out: string[] = [];
  for (let i = 1; i <= MAX_SHELLS; i++) {
    const name = shellName(sessionName, i);
    if (await tmux.hasSession(name)) out.push(name);
  }
  return out;
}

/**
 * Opens the next free shell slot, or returns the existing one if the caller
 * asked for a slot that is already running.
 *
 * Returns null when both slots are taken.
 */
export async function openShell(
  sessionName: string,
  fallbackCwd?: string,
): Promise<string | null> {
  for (let i = 1; i <= MAX_SHELLS; i++) {
    const name = shellName(sessionName, i);
    if (await tmux.hasSession(name)) continue;
    const cwd = shellCwd(sessionName, fallbackCwd);
    if (!cwd) return null;
    await tmux.createSession(name, cwd);
    return name;
  }
  return null;
}

export async function closeShell(shell: string): Promise<void> {
  if (!shell.startsWith(`${SHELL_PREFIX}-`)) return;
  if (await tmux.hasSession(shell)) await tmux.killSession(shell);
}

/** Called when a session goes away, so its shells do not outlive it. */
export async function closeShellsFor(sessionName: string): Promise<void> {
  for (const name of await listShells(sessionName)) {
    try {
      await tmux.killSession(name);
    } catch {
      /* Best-effort cleanup; a shell that will not die is not worth failing on. */
    }
  }
}
