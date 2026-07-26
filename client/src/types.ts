export interface QuickLaunch {
  id: string;
  label: string;
  sessionName?: string;
  targets: string[];
  agentType?: string;
}

export interface RepoConfig {
  alias: string;
  path: string;
  remote?: string;
}

export interface RepoWorktreeInfo {
  repoAlias: string;
  repoPath: string;
  path: string;
  branch?: string;
  head?: string;
  bare: boolean;
  isMain: boolean;
  configured: boolean;
  suggestedAlias: string;
  remote?: string;
  /** Display name of the agent that owns this worktree; absent if hand-made.
   *  Agent-owned worktrees are deleted when the agent stops. */
  agentSession?: string;
}

export interface RepoBranchInfo {
  name: string;
  /** Only exists on a remote — checking it out creates a local tracking branch. */
  remote: boolean;
  /** Full remote-tracking ref (e.g. "origin/feature") when remote is true. */
  ref?: string;
  /** Path of the worktree that already has this branch checked out, if any. */
  worktreePath?: string;
}

export interface RepoBranchesResponse {
  branches: RepoBranchInfo[];
  /** Branch a new branch should fork from unless the user picks another. */
  defaultBase: string;
}

export interface CreateRepoWorktreeRequest {
  repoAlias: string;
  branch: string;
  /** True to cut a new branch, false to check out one that already exists. */
  createBranch?: boolean;
  /** Start point for the new branch; ignored unless createBranch is set. */
  base?: string;
  /** Alias to register the worktree under; defaults to a generated one. */
  alias?: string;
}

export interface RepoWorktreeCreated {
  path: string;
  alias: string;
  branch: string;
}

export interface DeleteRepoWorktreeRequest {
  path: string;
  /** Delete even with uncommitted changes present. */
  force?: boolean;
  /** Also delete the branch the worktree had checked out. Off by default: removing
   *  a worktree is recoverable, deleting its branch can discard commits. */
  deleteBranch?: boolean;
  /** Delete the branch even when it isn't merged or pushed anywhere. */
  forceBranch?: boolean;
}

export interface RepoWorktreeDeleted {
  path: string;
  /** Alias that was dropped, if the worktree was registered. */
  alias?: string;
  /** Branch the worktree had checked out. */
  branch?: string;
  branchDeleted: boolean;
}

export type SessionStatus = "waiting" | "working" | "background" | "shell" | "unknown" | "stopped";

export type AgentType = "claude" | "cursor" | "codex";
export type WorktreeMode = "direct" | "fresh-current" | "fresh-main" | "fresh-custom";

export interface SessionInfo {
  name: string;
  displayName: string;
  windows: number;
  attached: boolean;
  created: number;
  path: string;
  worktrees: { repoPath: string; wtDir: string; managed?: boolean }[];
  status: SessionStatus;
  statusLine?: { type: string; message: string };
  agentType?: AgentType;
  parentSession?: string;
  children?: string[];
  sessionType?: string;
  meta?: Record<string, string>;
  /** Agent found running in a tmux pane Agentdock did not create. Read-only: the
   *  pane belongs to a terminal the user is attached to. */
  external?: boolean;
  /** Pane coordinates for an external agent, e.g. "workspace:3.4". */
  externalTarget?: string;
}

export interface MetaPropertyPreset {
  key: string;
  label: string;
  values: string[];
}

export interface McpServer {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface CreateSessionRequest {
  targets: string[];
  name?: string;
  prompt?: string;
  grouped?: boolean;
  isolated?: boolean;
  newBranch?: string;
  worktreeMode?: WorktreeMode;
  worktreeBase?: string;
  dangerouslySkipPermissions?: boolean;
  agentType?: AgentType;
  parentSession?: string;
  enableSubAgents?: boolean;
  sessionType?: string;
  meta?: Record<string, string>;
}
