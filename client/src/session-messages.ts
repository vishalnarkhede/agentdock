import type { AgentType, SessionInfo } from "./types";

/**
 * Confirmation copy for stopping agents.
 *
 * Worktrees only exist for repo-backed agents. A general chat (no targets) or an
 * agent on an existing checkout has nothing to clean up, so promising to remove
 * worktrees would warn about file deletion that will not happen.
 */

function hasWorktrees(sessions: SessionInfo[]): boolean {
  return sessions.some((s) => (s.worktrees?.length ?? 0) > 0);
}

/** Trailing sentence about worktree removal, empty when nothing would be removed. */
export function worktreeClause(sessions: SessionInfo[], plural = false): string {
  if (!hasWorktrees(sessions)) return "";
  return plural
    ? " Worktrees Agentdock created for them are removed; git branches are not deleted."
    : " The worktree Agentdock created for it is removed; the git branch is not deleted.";
}

/**
 * Display name for an agent type — the tool an agent runs on, never the agent itself.
 *
 * A type we have no label for falls through as-is rather than being shown as some
 * other tool's name.
 */
export function agentTypeLabel(type: AgentType | string): string {
  if (type === "claude") return "Claude";
  if (type === "cursor") return "Cursor";
  if (type === "codex") return "Codex";
  return type;
}
