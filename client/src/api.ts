import type {
  SessionInfo,
  RepoConfig,
  RepoWorktreeInfo,
  RepoBranchesResponse,
  CreateRepoWorktreeRequest,
  RepoWorktreeCreated,
  DeleteRepoWorktreeRequest,
  RepoWorktreeDeleted,
  CreateSessionRequest,
  AgentType,
  MetaPropertyPreset,
} from "./types";
import {
  isDemo,
  DEMO_SESSIONS,
  DEMO_PLANS,
  DEMO_CHANGES,
  DEMO_AUTH,
  DEMO_SETTINGS_STATUS,
  DEMO_SETTINGS_HEALTH,
  DEMO_REPOS,
  DEMO_TEMPLATES,
  getDemoOutput,
} from "./demo";

const BASE = "";

export async function fetchSessions(): Promise<SessionInfo[]> {
  if (isDemo()) return DEMO_SESSIONS.filter((s) => !s.parentSession);
  const res = await fetch(`${BASE}/api/sessions`);
  return res.json();
}

export async function createSession(
  req: CreateSessionRequest,
): Promise<{ sessions: string[] }> {
  if (isDemo()) return { sessions: [] };
  const res = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to launch agent");
  }
  return res.json();
}

export async function reorderSessions(order: string[]): Promise<void> {
  if (isDemo()) return;
  await fetch(`${BASE}/api/sessions/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order }),
  });
}

export async function deleteSession(name: string): Promise<void> {
  if (isDemo()) return;
  await fetch(`${BASE}/api/sessions/${name}`, { method: "DELETE" });
}

export async function restoreSession(name: string): Promise<void> {
  if (isDemo()) return;
  const res = await fetch(`${BASE}/api/sessions/${name}/restore`, { method: "POST" });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to restore agent");
  }
}

export async function deleteAllSessions(): Promise<void> {
  if (isDemo()) return;
  await fetch(`${BASE}/api/sessions`, { method: "DELETE" });
}

export async function fetchPlan(sessionName: string): Promise<string | null> {
  if (isDemo()) return DEMO_PLANS[sessionName] || null;
  const res = await fetch(`${BASE}/api/sessions/${sessionName}/plan`);
  const data = await res.json();
  return data.plan || null;
}

export async function openTerminal(name: string): Promise<void> {
  if (isDemo()) return;
  const res = await fetch(`${BASE}/api/sessions/${name}/open-terminal`, { method: "POST" });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to open terminal");
  }
}

/** Open (or reattach to) a shell in one of the agent's worktrees. */
export async function openShellSession(name: string, wtDir: string): Promise<string> {
  if (isDemo()) return "";
  const res = await fetch(`${BASE}/api/sessions/${name}/shell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wtDir }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to open shell");
  return data.shellSession;
}

export async function switchAgent(
  sessionName: string,
  agentType: AgentType,
  contextMessage?: string,
  onStep?: (step: string) => void,
): Promise<void> {
  if (isDemo()) return;
  const res = await fetch(`${BASE}/api/sessions/${sessionName}/switch-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentType, contextMessage }),
  });

  if (!res.ok) {
    // Non-SSE error (e.g. validation)
    const data = await res.json();
    throw new Error(data.error || "Failed to switch agent");
  }

  // Parse SSE stream
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response stream");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop() || "";

    for (const chunk of lines) {
      const dataLine = chunk.split("\n").find(l => l.startsWith("data: "));
      if (!dataLine) continue;
      const json = JSON.parse(dataLine.slice(6));
      onStep?.(json.step);
      if (json.error) throw new Error(json.step);
    }
  }
}

export async function fetchRepos(): Promise<RepoConfig[]> {
  if (isDemo()) return DEMO_REPOS;
  const res = await fetch(`${BASE}/api/repos`);
  return res.json();
}

export interface GitDiffStats {
  files: number;
  additions: number;
  deletions: number;
}

export interface GitBranchComparison extends GitDiffStats {
  ref: string;
  ahead: number;
  behind: number;
}

export interface GitSummaryResponse {
  branch: string;
  upstream: string | null;
  status: string;
  workingTree: GitDiffStats;
  comparison: GitBranchComparison | null;
}

export interface GitChangesResponse {
  status: string;
  diff: string;
  branch: string;
  prUrl: string | null;
}

export async function fetchGitChanges(path: string): Promise<GitChangesResponse> {
  if (isDemo()) return DEMO_CHANGES[path] || { status: "", diff: "", branch: "main", prUrl: null };
  const res = await fetch(`${BASE}/api/git/changes?path=${encodeURIComponent(path)}`);
  return res.json();
}

export async function fetchGitSummary(path: string): Promise<GitSummaryResponse> {
  if (isDemo()) {
    const changes = DEMO_CHANGES[path];
    return {
      branch: changes?.branch || "main",
      upstream: changes ? `origin/${changes.branch}` : "origin/main",
      status: changes?.status || "",
      workingTree: changes
        ? { files: 3, additions: 34, deletions: 10 }
        : { files: 0, additions: 0, deletions: 0 },
      comparison: changes
        ? { ref: "origin/main", ahead: 2, behind: 1, files: 5, additions: 128, deletions: 27 }
        : { ref: "origin/main", ahead: 0, behind: 0, files: 0, additions: 0, deletions: 0 },
    };
  }
  const res = await fetch(`${BASE}/api/git/summary?path=${encodeURIComponent(path)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to fetch git summary");
  return data;
}

export async function fetchGitRepos(path: string): Promise<string[]> {
  const res = await fetch(`${BASE}/api/git/repos?path=${encodeURIComponent(path)}`);
  const data = await res.json();
  return data.repos || [];
}

export interface GitLogCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  refs: string;
}

export interface GitLogResponse {
  branch: string;
  upstream: string | null;
  commits: GitLogCommit[];
}

export async function fetchGitLog(path: string, limit = 50): Promise<GitLogResponse> {
  if (isDemo()) {
    return {
      branch: "fix/oauth-token-refresh-race",
      upstream: "origin/fix/oauth-token-refresh-race",
      commits: [
        { hash: "7a4c9a283e6b1c84a1", shortHash: "7a4c9a2", author: "demo", date: "2026-07-18", subject: "fix token refresh race", refs: "HEAD -> fix/oauth-token-refresh-race" },
        { hash: "37c10f8790a42d7b9d", shortHash: "37c10f8", author: "demo", date: "2026-07-17", subject: "add token manager regression test", refs: "" },
      ],
    };
  }
  const res = await fetch(`${BASE}/api/git/log?path=${encodeURIComponent(path)}&limit=${limit}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to fetch git log");
  return data;
}

export async function fetchPRDiff(path: string): Promise<{ diff: string }> {
  if (isDemo()) return { diff: "" };
  const res = await fetch(`${BASE}/api/git/pr-diff?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to fetch PR diff");
  }
  return res.json();
}

export async function pushChanges(path: string): Promise<{ ok: boolean; branch: string }> {
  if (isDemo()) return { ok: true, branch: "demo" };
  const res = await fetch(`${BASE}/api/git/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to push");
  }
  return res.json();
}

export async function createPR(
  path: string,
  title: string,
  body?: string,
): Promise<{ url: string }> {
  if (isDemo()) return { url: "https://github.com/acme/api/pull/42" };
  const res = await fetch(`${BASE}/api/git/create-pr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, title, body }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to create PR");
  }
  return res.json();
}

export interface SessionTemplate {
  id: string;
  name: string;
  targets: string[];
  prompt?: string;
  isolated?: boolean;
  worktreeMode?: "direct" | "fresh-current" | "fresh-main" | "fresh-custom";
  worktreeBase?: string;
  grouped?: boolean;
  meta?: Record<string, string>;
}

export async function fetchTemplates(): Promise<SessionTemplate[]> {
  if (isDemo()) return DEMO_TEMPLATES;
  const res = await fetch(`${BASE}/api/templates`);
  return res.json();
}

export async function saveTemplate(
  template: Omit<SessionTemplate, "id">,
): Promise<SessionTemplate> {
  if (isDemo()) return { ...template, id: "demo" };
  const res = await fetch(`${BASE}/api/templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(template),
  });
  return res.json();
}

export async function deleteTemplate(id: string): Promise<void> {
  if (isDemo()) return;
  await fetch(`${BASE}/api/templates/${id}`, { method: "DELETE" });
}


export async function sendSessionInput(sessionName: string, text: string): Promise<void> {
  if (isDemo()) return;
  const res = await fetch(`${BASE}/api/sessions/${sessionName}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to send input");
  }
}

export async function uploadFile(file: File): Promise<string> {
  if (isDemo()) return "/tmp/demo-upload";
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/api/upload`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Upload failed");
  }
  const data = await res.json();
  return data.path;
}

export async function fetchSessionOutput(
  sessionName: string,
  lines = 50,
): Promise<{ output: string; status: string; statusLine?: { type: string; message: string } }> {
  if (isDemo()) return getDemoOutput(sessionName);
  const res = await fetch(`${BASE}/api/sessions/${sessionName}/output?lines=${lines}`);
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to fetch output");
  }
  return res.json();
}

export async function fetchSessionChildren(sessionName: string): Promise<SessionInfo[]> {
  if (isDemo()) return DEMO_SESSIONS.filter((s) => s.parentSession === sessionName);
  const res = await fetch(`${BASE}/api/sessions/${sessionName}/children`);
  return res.json();
}

export function wsUrl(sessionName: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/sessions/${sessionName}`;
}

// ─── File System API ───

export interface FsEntry {
  name: string;
  type: "file" | "dir";
  ext?: string;
}

export async function fetchFsDir(path: string, roots: string[]): Promise<FsEntry[]> {
  const params = new URLSearchParams({ path });
  if (roots.length > 0) params.set("roots", roots.join(","));
  const res = await fetch(`${BASE}/api/fs/list?${params}`);
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to list directory");
  }
  const data = await res.json();
  return data.entries;
}

export async function searchFsFiles(query: string, roots: string[]): Promise<Array<{ path: string; name: string; type: "file" | "dir" }>> {
  const params = new URLSearchParams({ q: query });
  if (roots.length > 0) params.set("roots", roots.join(","));
  const res = await fetch(`${BASE}/api/fs/search?${params}`);
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Search failed");
  }
  const data = await res.json();
  return data.results;
}

export interface GrepResult {
  path: string;
  name: string;
  lineNumber: number;
  line: string;
}

export async function grepFsFiles(query: string, roots: string[]): Promise<GrepResult[]> {
  const params = new URLSearchParams({ q: query });
  if (roots.length > 0) params.set("roots", roots.join(","));
  const res = await fetch(`${BASE}/api/fs/grep?${params}`);
  if (!res.ok) {
    let message = "Grep failed";
    try {
      const data = await res.json();
      message = data.error || message;
    } catch {}
    throw new Error(message);
  }
  const data = await res.json();
  return data.results ?? [];
}

export async function fetchFsFile(path: string, roots: string[]): Promise<{ content: string; language: string; size: number }> {
  const params = new URLSearchParams({ path });
  if (roots.length > 0) params.set("roots", roots.join(","));
  const res = await fetch(`${BASE}/api/fs/read?${params}`);
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to read file");
  }
  return res.json();
}

// ─── Settings API ───

export interface ToolHealth {
  installed: boolean;
  version: string;
}

export interface SettingsHealth {
  tmux: ToolHealth;
  claude: ToolHealth;
  cursor: ToolHealth;
  codex: ToolHealth;
  git: ToolHealth;
  gh: ToolHealth;
  bun: ToolHealth;
  jq: ToolHealth;
  psql: ToolHealth;
  ngrok: ToolHealth;
}

export interface SettingsStatus {
  firstRun: boolean;
  needsSetup: boolean;
  basePath: string;
  repoCount: number;
  hasReposFile: boolean;
}

export interface CustomAction {
  id: string;
  label: string;
  hint: string;
  prompt: string;
}

export async function fetchSettingsHealth(): Promise<SettingsHealth> {
  if (isDemo()) return DEMO_SETTINGS_HEALTH;
  const res = await fetch(`${BASE}/api/settings/health`);
  return res.json();
}


export async function fetchSettingsStatus(): Promise<SettingsStatus> {
  if (isDemo()) return DEMO_SETTINGS_STATUS;
  const res = await fetch(`${BASE}/api/settings/status`);
  return res.json();
}

export async function fetchBasePath(): Promise<string> {
  if (isDemo()) return "~/projects";
  const res = await fetch(`${BASE}/api/settings/base-path`);
  const data = await res.json();
  return data.path;
}

export async function updateBasePath(path: string): Promise<void> {
  if (isDemo()) return;
  await fetch(`${BASE}/api/settings/base-path`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

export async function fetchSettingsRepos(): Promise<RepoConfig[]> {
  if (isDemo()) return DEMO_REPOS;
  const res = await fetch(`${BASE}/api/settings/repos`);
  return res.json();
}

export async function addSettingsRepo(repo: RepoConfig): Promise<void> {
  if (isDemo()) return;
  await fetch(`${BASE}/api/settings/repos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(repo),
  });
}

export async function scanRepos(): Promise<RepoConfig[]> {
  if (isDemo()) return DEMO_REPOS;
  const res = await fetch(`${BASE}/api/settings/repos/scan`);
  return res.json();
}

export async function fetchRepoWorktrees(): Promise<RepoWorktreeInfo[]> {
  if (isDemo()) return [];
  const res = await fetch(`${BASE}/api/settings/repos/worktrees`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to discover worktrees");
  }
  return res.json();
}

export async function fetchRepoBranches(alias: string): Promise<RepoBranchesResponse> {
  if (isDemo()) return { branches: [], defaultBase: "main" };
  const res = await fetch(`${BASE}/api/settings/repos/${encodeURIComponent(alias)}/branches`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to list branches");
  }
  return res.json();
}

export async function createRepoWorktree(
  input: CreateRepoWorktreeRequest,
): Promise<RepoWorktreeCreated> {
  if (isDemo()) throw new Error("Not available in demo mode");
  const res = await fetch(`${BASE}/api/settings/repos/worktrees`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to create worktree");
  return data;
}

export class WorktreeDirtyError extends Error {
  constructor(message: string, public readonly changes: number) {
    super(message);
    this.name = "WorktreeDirtyError";
  }
}

export class BranchUnmergedError extends Error {
  constructor(message: string, public readonly branch: string) {
    super(message);
    this.name = "BranchUnmergedError";
  }
}

export async function deleteRepoWorktree(
  input: DeleteRepoWorktreeRequest,
): Promise<RepoWorktreeDeleted> {
  if (isDemo()) throw new Error("Not available in demo mode");
  const res = await fetch(`${BASE}/api/settings/repos/worktrees`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409 && data.needsForce) {
    throw new WorktreeDirtyError(data.error || "Worktree has uncommitted changes", data.changes ?? 0);
  }
  if (res.status === 409 && data.needsBranchForce) {
    throw new BranchUnmergedError(data.error || "Branch is not merged", data.branch || "");
  }
  if (!res.ok) throw new Error(data.error || "Failed to delete worktree");
  return data;
}

export async function deleteSettingsRepo(alias: string): Promise<void> {
  if (isDemo()) return;
  await fetch(`${BASE}/api/settings/repos/${encodeURIComponent(alias)}`, {
    method: "DELETE",
  });
}


// ─── Auth API ───

export interface AuthStatus {
  enabled: boolean;
  loggedIn: boolean;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  if (isDemo()) return DEMO_AUTH;
  const res = await fetch(`${BASE}/api/auth/status`);
  return res.json();
}

export async function login(password: string): Promise<{ ok?: boolean; error?: string }> {
  if (isDemo()) return { ok: true };
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return res.json();
}

export async function logout(): Promise<void> {
  if (isDemo()) return;
  await fetch(`${BASE}/api/auth/logout`, { method: "POST" });
}

export async function setPassword(password: string): Promise<{ ok?: boolean; error?: string }> {
  if (isDemo()) return { ok: true };
  const res = await fetch(`${BASE}/api/auth/password`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return res.json();
}

// ─── Database Shards API ───

export interface DbShardInfo {
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  engine?: string;
  sslmode?: string;
}

export async function fetchDbShards(): Promise<DbShardInfo[]> {
  if (isDemo()) return [];
  const res = await fetch(`${BASE}/api/db/shards`);
  return res.json();
}

export async function addDbShardApi(shard: {
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  engine?: string;
  sslmode?: string;
}): Promise<void> {
  if (isDemo()) return;
  const res = await fetch(`${BASE}/api/db/shards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(shard),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to add shard");
  }
}

export async function deleteDbShard(name: string): Promise<void> {
  if (isDemo()) return;
  await fetch(`${BASE}/api/db/shards/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export async function testDbShard(name: string): Promise<{ ok: boolean; error?: string; duration?: number }> {
  if (isDemo()) return { ok: true, duration: 12 };
  const res = await fetch(`${BASE}/api/db/test/${encodeURIComponent(name)}`);
  return res.json();
}

// ─── Custom Quick Actions API ───

export async function fetchCustomActions(): Promise<CustomAction[]> {
  if (isDemo()) return [];
  const res = await fetch(`${BASE}/api/settings/quick-actions`);
  return res.json();
}

export async function createCustomAction(action: Omit<CustomAction, "id">): Promise<CustomAction> {
  if (isDemo()) return { ...action, id: "demo" };
  const res = await fetch(`${BASE}/api/settings/quick-actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });
  return res.json();
}

export async function deleteCustomAction(id: string): Promise<void> {
  if (isDemo()) return;
  await fetch(`${BASE}/api/settings/quick-actions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ─── MCP Servers API ───

export interface McpServerInfo {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export async function fetchMcpServers(): Promise<McpServerInfo[]> {
  if (isDemo()) return [];
  const res = await fetch(`${BASE}/api/settings/mcp-servers`);
  return res.json();
}

export async function addMcpServerApi(server: McpServerInfo): Promise<void> {
  if (isDemo()) return;
  const res = await fetch(`${BASE}/api/settings/mcp-servers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(server),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to add MCP server");
  }
}

export async function deleteMcpServer(name: string): Promise<void> {
  if (isDemo()) return;
  await fetch(`${BASE}/api/settings/mcp-servers/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

// ─── Preferences API ───

export async function fetchPreferences(): Promise<Record<string, any>> {
  if (isDemo()) return { groupBy: "project" };
  const res = await fetch(`${BASE}/api/settings/preferences`);
  return res.json();
}

export async function updatePreferences(partial: Record<string, any>): Promise<Record<string, any>> {
  if (isDemo()) return partial;
  const res = await fetch(`${BASE}/api/settings/preferences`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(partial),
  });
  return res.json();
}

// ─── Meta Property Presets API ───

export async function fetchMetaPropertyPresets(): Promise<MetaPropertyPreset[]> {
  if (isDemo()) return [{ key: "project", label: "Project", values: [] }];
  const res = await fetch(`${BASE}/api/settings/meta-properties`);
  return res.json();
}

export async function saveMetaPropertyPresets(presets: MetaPropertyPreset[]): Promise<void> {
  if (isDemo()) return;
  await fetch(`${BASE}/api/settings/meta-properties`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(presets),
  });
}

// ─── Session Meta API ───

export async function updateSessionMeta(
  sessionName: string,
  meta: Record<string, string>,
): Promise<Record<string, string>> {
  if (isDemo()) return meta;
  const res = await fetch(`${BASE}/api/sessions/${sessionName}/meta`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(meta),
  });
  return res.json();
}

// ─── Ngrok API ───

// Keep in sync with NgrokStatus in server/src/types.ts.

export const NGROK_ERROR_REASONS = [
  "not_installed",
  "not_authed",
  "basic_auth_unsupported",
  "agent_conflict",
  "timeout",
  "unprotected",
  "unknown",
] as const;

export type NgrokErrorReason = (typeof NGROK_ERROR_REASONS)[number];

/** How a live tunnel is protected. "weak-password" still allows access — it only warns. */
export type NgrokProtection = "basic-auth" | "password" | "weak-password" | "none";

export interface NgrokStatus {
  running: boolean;
  url: string | null;
  /** One human-readable sentence. Present only on failure. */
  error?: string;
  reason?: NgrokErrorReason;
  /** Raw ngrok log, truncated — shown behind a disclosure. */
  detail?: string;
  protection: NgrokProtection;
}

function currentShareTargetPort(): string {
  return window.location.port || "5173";
}

export async function fetchNgrokStatus(): Promise<NgrokStatus> {
  if (isDemo()) return { running: false, url: null, protection: "none" };
  const targetPort = encodeURIComponent(currentShareTargetPort());
  const res = await fetch(`${BASE}/api/ngrok/status?targetPort=${targetPort}`);
  return res.json();
}

export async function startNgrok(opts?: { acknowledgeUnprotected?: boolean }): Promise<NgrokStatus> {
  const targetPort = currentShareTargetPort();
  const res = await fetch(`${BASE}/api/ngrok/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetPort, acknowledgeUnprotected: opts?.acknowledgeUnprotected }),
  });
  const text = await res.text();
  try {
    // A 409 (the unprotected gate) is a normal outcome, not an exception — the body
    // carries the reason the caller needs to render.
    return JSON.parse(text);
  } catch {
    throw new Error(`Couldn't start the share link (${res.status}): ${text.slice(0, 200)}`);
  }
}

export async function stopNgrok(): Promise<void> {
  await fetch(`${BASE}/api/ngrok/stop`, { method: "POST" });
}

export async function fetchNgrokBasicAuthStatus(): Promise<{ configured: boolean }> {
  if (isDemo()) return { configured: false };
  const res = await fetch(`${BASE}/api/settings/ngrok-basic-auth`);
  return res.json();
}

export async function setNgrokBasicAuth(value: string): Promise<{ ok?: boolean; error?: string }> {
  const res = await fetch(`${BASE}/api/settings/ngrok-basic-auth`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  return res.json();
}

export async function deleteNgrokBasicAuth(): Promise<void> {
  await fetch(`${BASE}/api/settings/ngrok-basic-auth`, { method: "DELETE" });
}

