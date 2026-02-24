export interface RepoConfig {
  alias: string;
  path: string;
  remote?: string;
}

export type SessionStatus = "waiting" | "working" | "shell" | "unknown";

export type AgentType = "claude" | "cursor";

export interface SessionInfo {
  name: string;
  displayName: string;
  windows: number;
  attached: boolean;
  created: number;
  path: string;
  worktrees: { repoPath: string; wtDir: string }[];
  status: SessionStatus;
  statusLine?: { type: string; message: string };
  agentType?: AgentType;
  parentSession?: string;
  children?: string[];
  sessionType?: string;
}

export interface LinearTicket {
  identifier: string;
  title: string;
  description?: string;
  url?: string;
  branchName?: string;
}

export interface CreateSessionRequest {
  targets: string[];
  name?: string;
  prompt?: string;
  ticket?: string;
  grouped?: boolean;
  isolated?: boolean;
  newBranch?: string;
  dangerouslySkipPermissions?: boolean;
  agentType?: AgentType;
  parentSession?: string;
  enableSubAgents?: boolean;
  sessionType?: string;
}
