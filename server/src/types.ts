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
  worktrees: WorktreeMeta[];
  status: SessionStatus;
  statusLine?: { type: string; message: string };
  agentType?: AgentType;
  parentSession?: string;
  children?: string[];
  sessionType?: string;
}

export interface WorktreeMeta {
  repoPath: string;
  wtDir: string;
}

export interface LinearTicket {
  identifier: string;
  title: string;
  description?: string;
  url?: string;
  branchName?: string;
}

export interface DbShard {
  name: string;       // e.g. "us_east:c1"
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  engine?: "postgres" | "cockroachdb";
  sslmode?: string;
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
}
