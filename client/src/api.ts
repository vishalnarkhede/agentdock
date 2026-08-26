import type {
  SessionInfo,
  RepoConfig,
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
    throw new Error(data.error || "Failed to create session");
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
    throw new Error(data.error || "Failed to restore session");
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

export async function openInIterm(name: string): Promise<void> {
  if (isDemo()) return;
  const res = await fetch(`${BASE}/api/sessions/${name}/open-iterm`, { method: "POST" });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to open iTerm");
  }
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

export async function fetchGitChanges(
  path: string,
): Promise<{ status: string; diff: string; branch: string; prUrl: string | null }> {
  if (isDemo()) return DEMO_CHANGES[path] || { status: "", diff: "", branch: "main", prUrl: null };
  const res = await fetch(`${BASE}/api/git/changes?path=${encodeURIComponent(path)}`);
  return res.json();
}

export async function fetchGitRepos(path: string): Promise<string[]> {
  const res = await fetch(`${BASE}/api/git/repos?path=${encodeURIComponent(path)}`);
  const data = await res.json();
  return data.repos || [];
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

export function wsUrl(
  sessionName: string,
  size?: { cols: number; rows: number },
): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams();
  /* A PTY must start at the browser's real grid size. Attaching at 80×24 and
     resizing one message later makes tmux perform an avoidable second redraw. */
  if (size) {
    params.set("cols", String(Math.round(size.cols)));
    params.set("rows", String(Math.round(size.rows)));
  }
  const query = params.toString();
  return `${proto}//${window.location.host}/ws/sessions/${sessionName}${query ? `?${query}` : ""}`;
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

export async function fetchFsFile(path: string, roots: string[]): Promise<{ content: string; language: string; size: number; version: string }> {
  const params = new URLSearchParams({ path });
  if (roots.length > 0) params.set("roots", roots.join(","));
  const res = await fetch(`${BASE}/api/fs/read?${params}`);
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to read file");
  }
  return res.json();
}

export interface WriteConflict {
  conflict: true;
  error: string;
  currentVersion: string;
  currentContent: string;
}

export interface WriteOk {
  ok: true;
  version: string;
  size: number;
}

/**
 * Save a file. `version` is the token /read handed back; the server refuses the
 * write if the file changed since, which is what stops a save from quietly
 * overwriting whatever the agent wrote in the meantime.
 */
export async function writeFsFile(
  path: string,
  roots: string[],
  content: string,
  version: string,
  force = false,
): Promise<WriteOk | WriteConflict> {
  const res = await fetch(`${BASE}/api/fs/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, roots: roots.join(","), content, version, force }),
  });
  const data = await res.json();
  if (res.status === 409) return data as WriteConflict;
  if (!res.ok) throw new Error(data.error || "Failed to save file");
  return data as WriteOk;
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
  git: ToolHealth;
  gh: ToolHealth;
  bun: ToolHealth;
  psql: ToolHealth;
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

// ─── What MCP servers the agents have (read-only) ───

/** Names, commands and args of every MCP server the agent CLIs are configured
 *  with. Read from their own config, so it sees servers added outside AgentDock. */
export async function fetchAgentMcpNames(): Promise<string[]> {
  if (isDemo()) return [];
  const res = await fetch(`${BASE}/api/settings/agent-mcp`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.names) ? data.names : [];
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

export async function renameSession(
  sessionName: string,
  newName: string,
): Promise<{ name: string; displayName: string }> {
  if (isDemo()) return { name: sessionName, displayName: newName };
  const res = await fetch(`${BASE}/api/sessions/${sessionName}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to rename session");
  }
  return res.json();
}

// ─── Ngrok API ───

export interface NgrokStatus {
  running: boolean;
  url: string | null;
}

export async function fetchNgrokStatus(): Promise<NgrokStatus> {
  if (isDemo()) return { running: false, url: null };
  const res = await fetch(`${BASE}/api/ngrok/status`);
  return res.json();
}

export async function startNgrok(): Promise<NgrokStatus> {
  const res = await fetch(`${BASE}/api/ngrok/start`, { method: "POST" });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`ngrok start failed (${res.status}): ${text.slice(0, 200)}`);
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

// ─── Phone link ───

export interface PhoneAddress {
  host: string;
  iface: string;
  kind: "wifi" | "ethernet" | "vpn" | "other" | "mdns";
  note: string;
}

export interface PhoneLink {
  addresses: PhoneAddress[];
  ports: { port: number; scheme: "http" | "https" }[];
  url: string | null;
  problem?: string;
}

/** Never cached: the address changes with the network. */
export async function fetchPhoneLink(): Promise<PhoneLink> {
  if (isDemo()) {
    return { addresses: [], ports: [], url: null, problem: "Not available in the demo." };
  }
  const res = await fetch(`${BASE}/api/network/phone`);
  if (!res.ok) throw new Error(`could not read the network (${res.status})`);
  return res.json();
}


// ─── Worktrees ───

export interface WorktreeInfo {
  path: string;
  repo: string;
  repoPath: string;
  branch: string | null;
  head: string;
  primary: boolean;
  session: string | null;
  sessionName: string | null;
  prunable: boolean;
  exists: boolean;
  dirty: number | null;
}

export async function fetchWorktrees(): Promise<WorktreeInfo[]> {
  if (isDemo()) return [];
  const res = await fetch(`${BASE}/api/worktrees`);
  if (!res.ok) throw new Error("Failed to list worktrees");
  const data = await res.json();
  return Array.isArray(data.worktrees) ? data.worktrees : [];
}

export interface WorktreeDeleteResult {
  path: string;
  ok: boolean;
  error?: string;
}

/**
 * Removes one or several worktrees. `force` is the answer to the server's own
 * refusal when they hold uncommitted work — it is never sent unprompted.
 */
export async function deleteWorktrees(
  paths: string[],
  force = false,
): Promise<{
  worktrees?: WorktreeInfo[];
  results?: WorktreeDeleteResult[];
  error?: string;
  status: number;
}> {
  const res = await fetch(`${BASE}/api/worktrees`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths, force }),
  });
  const data = await res.json().catch(() => ({}));
  return { ...(data as any), status: res.status };
}

// ─── Plain shells beside the agent ───

export async function fetchShells(session: string): Promise<string[]> {
  if (isDemo()) return [];
  const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(session)}/shells`);
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.shells) ? data.shells : [];
}

export async function openShell(session: string): Promise<string[]> {
  const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(session)}/shells`, {
    method: "POST",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error || "Could not open a shell");
  return Array.isArray((data as any).shells) ? (data as any).shells : [];
}

export async function closeShell(session: string, index: number): Promise<string[]> {
  const res = await fetch(
    `${BASE}/api/sessions/${encodeURIComponent(session)}/shells/${index}`,
    { method: "DELETE" },
  );
  const data = await res.json().catch(() => ({}));
  return Array.isArray((data as any).shells) ? (data as any).shells : [];
}

// ─── Review summary ───

/** The counts the Plan and Changes headers show. */
export interface PanelSummary {
  plan: { total: number; done: number };
  diff: { files: number; plus: number; minus: number };
  hasPlan: boolean;
}

export async function fetchPanelSummary(
  session: string,
  paths: string[],
): Promise<PanelSummary> {
  const qs = new URLSearchParams();
  qs.set("session", session);
  for (const p of paths) qs.append("path", p);
  const res = await fetch(`${BASE}/api/review/summary?${qs.toString()}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as any).error || "Failed to load summary");
  }
  return res.json();
}

// ─── Status hooks ───

export interface HookState {
  installed: string[];
  missing: string[];
  ok: boolean;
  settingsPath: string;
  scriptPath: string;
  events: { event: string; status: string; means: string }[];
}

export async function fetchHookState(): Promise<HookState> {
  const res = await fetch(`${BASE}/api/settings/hooks`);
  if (!res.ok) throw new Error("Failed to read hook state");
  return res.json();
}

export async function installHooks(): Promise<HookState> {
  const res = await fetch(`${BASE}/api/settings/hooks`, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error || "Install failed");
  return data as HookState;
}

export interface ConflictPair {
  sessions: [string, string];
  files: string[];
}

export interface ConflictResult {
  conflicts: ConflictPair[];
  worktrees: { session: string; fileCount: number }[];
}

export async function fetchConflicts(): Promise<ConflictResult> {
  const res = await fetch(`${BASE}/api/review/conflicts`);
  if (!res.ok) throw new Error("Failed to scan for conflicts");
  return res.json();
}

