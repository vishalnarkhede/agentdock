export interface RepoConfig {
  alias: string;
  path: string;
  remote?: string;
}

export type SessionStatus = "waiting" | "working" | "background" | "shell" | "unknown";

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
  meta?: Record<string, string>;
}

export interface MetaPropertyPreset {
  key: string;
  label: string;
  values: string[];
}

export interface LinearTicket {
  identifier: string;
  title: string;
  description?: string;
  url?: string;
  branchName?: string;
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
  ticket?: string;
  grouped?: boolean;
  isolated?: boolean;
  newBranch?: string;
  dangerouslySkipPermissions?: boolean;
  agentType?: AgentType;
  parentSession?: string;
  enableSubAgents?: boolean;
  sessionType?: string;
  meta?: Record<string, string>;
}
