/**
 * Plain shells attached to an agent's worktrees, for the Shell tab.
 *
 * These are ordinary tmux sessions streamed through the same WebSocket as an
 * agent pane — handleWsOpen only needs a session name — so there is no transport
 * code here, just naming and lifecycle.
 */

import { createHash } from "crypto";
import { PREFIX } from "./config";
import * as tmux from "./tmux";

/**
 * Deliberately not PREFIX. Sessions are listed with listSessions(PREFIX), so a
 * shell named "claude-…" would show up in the sidebar as an agent that does not
 * exist. External-agent discovery is safe already: it filters on
 * isAgentCommand(pane.command), and a shell reports its shell.
 *
 * No trailing hyphen, matching PREFIX — listSessions() appends one itself.
 */
export const SHELL_PREFIX = "adshell";

function agentSlug(agentSession: string): string {
  return agentSession.startsWith(`${PREFIX}-`)
    ? agentSession.slice(PREFIX.length + 1)
    : agentSession;
}

/**
 * Stable for a given (agent, worktree) pair so reopening the tab reattaches to
 * the shell the user left behind instead of spawning a new one each time. The
 * path is hashed rather than slugged because worktree paths are long, and two
 * worktrees in one agent often differ only deep in the path.
 */
export function shellSessionName(agentSession: string, wtDir: string): string {
  const hash = createHash("sha256").update(wtDir).digest("hex").slice(0, 8);
  return `${SHELL_PREFIX}-${agentSlug(agentSession)}-${hash}`;
}

export async function ensureShellSession(agentSession: string, wtDir: string): Promise<string> {
  const name = shellSessionName(agentSession, wtDir);
  if (!(await tmux.hasSession(name))) {
    await tmux.createSession(name, wtDir);
  }
  return name;
}

export async function listShellSessions(agentSession: string): Promise<string[]> {
  // listSessions appends "-", so this matches "adshell-<slug>-<hash>" and not
  // a different agent whose slug merely starts with the same characters.
  const sessions = await tmux.listSessions(`${SHELL_PREFIX}-${agentSlug(agentSession)}`);
  return sessions.map((s) => s.name);
}

export async function killShellSessions(agentSession: string): Promise<void> {
  for (const name of await listShellSessions(agentSession)) {
    try {
      await tmux.killSession(name);
    } catch {
      // Best effort: a shell that is already gone must not block agent teardown.
    }
  }
}
