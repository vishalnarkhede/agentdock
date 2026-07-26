import { basename } from "path";
import { isAgentCommand, listAllPanes } from "./tmux";
import { getRepos, PREFIX } from "./config";
import type { AgentType, WorktreeMeta } from "../types";

/**
 * Agents the user started themselves — `claude` running in one of their own tmux
 * panes rather than in a session Agentdock created.
 *
 * Agentdock's unit of an agent is a whole tmux session named `{PREFIX}-*`. These
 * live as panes inside sessions it knows nothing about, so they are identified by
 * what is running in the pane and where, never by session name.
 *
 * They are read-only. The pane belongs to a terminal the user is attached to and
 * typing in, so sending keys or killing it would write into their live session.
 */
export interface ExternalAgent {
  /** URL-safe stable id, e.g. "external-44". */
  name: string;
  /** tmux pane id, e.g. "%44". Stable for the pane's lifetime. */
  paneId: string;
  /** Human-readable pane coordinates, e.g. "workspace:3.4". */
  paneTarget: string;
  sessionName: string;
  command: string;
  path: string;
  agentType?: AgentType;
  worktrees: WorktreeMeta[];
}

const NAME_PREFIX = "external-";

export function isExternalAgentName(name: string): boolean {
  return name.startsWith(NAME_PREFIX);
}

/**
 * "external-44" → "%44".
 *
 * The pane id is the natural key — window/pane coordinates shift as panes are
 * opened and closed — but its leading `%` would have to survive URL encoding on
 * the WebSocket path, so it is carried in this stable, URL-safe form instead.
 */
export function paneIdFromExternalName(name: string): string | null {
  if (!isExternalAgentName(name)) return null;
  const suffix = name.slice(NAME_PREFIX.length);
  return /^\d+$/.test(suffix) ? `%${suffix}` : null;
}

function agentTypeFor(command: string): AgentType | undefined {
  if (command === "claude") return "claude";
  if (command === "agent") return "cursor";
  return undefined;
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

/**
 * Tie the pane's cwd to a registered repo, so the agent groups under the workspace
 * it is working in.
 *
 * The longest containing path wins: a worktree imported as its own repo sits under
 * `{repo}__worktrees/{branch}`, and matching it to the repo it forked from would
 * file the agent under the wrong workspace. A pane in an unregistered directory
 * gets no worktrees and simply stays ungrouped — importing the workspace is what
 * gives it a home, which is the point.
 */
export function worktreesForPath(panePath: string): WorktreeMeta[] {
  const cwd = stripTrailingSlash(panePath);
  if (!cwd) return [];

  let bestPath = "";
  for (const repo of getRepos()) {
    const repoPath = stripTrailingSlash(repo.path);
    if (!repoPath) continue;
    if (cwd !== repoPath && !cwd.startsWith(`${repoPath}/`)) continue;
    if (repoPath.length > bestPath.length) bestPath = repoPath;
  }
  return bestPath ? [{ repoPath: bestPath, wtDir: cwd }] : [];
}

/**
 * Every agent pane on the tmux server that Agentdock did not launch.
 *
 * Panes inside `{PREFIX}-*` sessions are skipped: those are Agentdock's own agents
 * and are already listed as first-class sessions, so including them here would show
 * each one twice.
 */
export async function discoverExternalAgents(): Promise<ExternalAgent[]> {
  const panes = await listAllPanes();

  return panes
    .filter((pane) => isAgentCommand(pane.command))
    .filter((pane) => !pane.sessionName.startsWith(`${PREFIX}-`))
    .map((pane) => ({
      name: `${NAME_PREFIX}${pane.id.replace("%", "")}`,
      paneId: pane.id,
      paneTarget: `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex}`,
      sessionName: pane.sessionName,
      command: pane.command,
      path: pane.path,
      agentType: agentTypeFor(pane.command),
      worktrees: worktreesForPath(pane.path),
    }));
}

/** Label for the agents bar: the directory being worked in, falling back to the pane. */
export function externalDisplayName(agent: ExternalAgent): string {
  return basename(stripTrailingSlash(agent.path)) || agent.paneTarget;
}
