import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, appendFileSync, chmodSync } from "fs";
import { join, resolve } from "path";
import type { RepoConfig, WorktreeMeta, DbShard, McpServer } from "../types";

import { homedir } from "os";

const HOME = process.env.HOME || homedir();
const CONFIG_DIR = process.env.AGENTDOCK_CONFIG_DIR || join(HOME, ".config", "agentdock");
const REPOS_FILE = join(CONFIG_DIR, "repos.json");
const BASE_PATH_FILE = join(CONFIG_DIR, "base-path");
const AUTH_PASSWORD_FILE = join(CONFIG_DIR, "auth-password");
const NGROK_BASIC_AUTH_FILE = join(CONFIG_DIR, "ngrok-basic-auth");
const DB_SHARDS_DIR = join(CONFIG_DIR, "db-shards");
const DB_SHARDS_FILE = join(DB_SHARDS_DIR, "shards.json");
const SESSIONS_DIR = join(CONFIG_DIR, "sessions");
const PLANS_DIR = join(CONFIG_DIR, "plans");
const QUICK_ACTIONS_FILE = join(CONFIG_DIR, "quick-actions.json");

// The agentdock repo root (server/src/services/ → up 3 levels)
export const AGENTDOCK_REPO_DIR = resolve(__dirname, "../../..");

// No legacy repos — configure repos via the web UI or repos.json

function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

// ─── Base path ───

export function hasBasePath(): boolean {
  return existsSync(BASE_PATH_FILE);
}

export function getBasePath(): string {
  if (process.env.AGENTDOCK_BASE_PATH) return process.env.AGENTDOCK_BASE_PATH;
  if (existsSync(BASE_PATH_FILE)) {
    const val = readFileSync(BASE_PATH_FILE, "utf-8").trim();
    if (val) return val;
  }
  return join(HOME, "projects");
}

export function setBasePath(path: string): void {
  ensureConfigDir();
  writeFileSync(BASE_PATH_FILE, path.trim());
}

// ─── Repos ───

function loadReposFile(): RepoConfig[] | null {
  if (!existsSync(REPOS_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(REPOS_FILE, "utf-8"));
    if (Array.isArray(data)) return data;
  } catch { /* corrupt file */ }
  return null;
}

function saveReposFile(repos: RepoConfig[]): void {
  ensureConfigDir();
  writeFileSync(REPOS_FILE, JSON.stringify(repos, null, 2));
}

export function getRepos(): RepoConfig[] {
  const fromFile = loadReposFile();
  if (fromFile !== null) return fromFile;
  return [];
}

export function addRepo(repo: RepoConfig): void {
  const repos = getRepos();
  const existing = repos.findIndex((r) => r.alias === repo.alias);
  if (existing !== -1) {
    repos[existing] = repo;
  } else {
    repos.push(repo);
  }
  saveReposFile(repos);
}

export function removeRepo(alias: string): void {
  const repos = getRepos().filter((r) => r.alias !== alias);
  saveReposFile(repos);
}

/** Sync repos.json with what's actually on disk in the base path. */
export function syncRepos(): void {
  const scanned = scanBasePath();
  if (scanned.length === 0) return;
  const current = getRepos();
  const currentByPath = new Map(current.map((r) => [r.path, r]));
  const scannedPaths = new Set(scanned.map((r) => r.path));

  let changed = false;
  const merged = [...current];

  // Add new repos found on disk
  for (const repo of scanned) {
    if (!currentByPath.has(repo.path)) {
      merged.push(repo);
      changed = true;
    }
  }

  // Remove repos whose directories no longer exist
  const filtered = merged.filter((r) => {
    if (scannedPaths.has(r.path)) return true;
    // Keep repos outside the base path (manually added)
    const base = getBasePath();
    if (!r.path.startsWith(base)) return true;
    // Remove if directory is gone
    if (!existsSync(r.path)) {
      changed = true;
      return false;
    }
    return true;
  });

  if (changed) saveReposFile(filtered);
}

export function scanBasePath(): RepoConfig[] {
  const base = getBasePath();
  if (!existsSync(base)) return [];
  const entries = readdirSync(base, { withFileTypes: true });
  const repos: RepoConfig[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dirPath = join(base, entry.name);
    if (existsSync(join(dirPath, ".git"))) {
      // Try to get remote URL
      let remote: string | undefined;
      try {
        const configFile = join(dirPath, ".git", "config");
        if (existsSync(configFile)) {
          const content = readFileSync(configFile, "utf-8");
          const match = content.match(/url\s*=\s*(.+)/);
          if (match) remote = match[1].trim();
        }
      } catch { /* ignore */ }
      repos.push({ alias: entry.name, path: dirPath, remote });
    }
  }
  return repos;
}

export function hasReposFile(): boolean {
  return existsSync(REPOS_FILE);
}

export function resolveAlias(alias: string): RepoConfig | undefined {
  // Built-in alias: "__agentdock__" always resolves to the agentdock repo itself
  if (alias === "__agentdock__") {
    return { alias: "agentdock", path: AGENTDOCK_REPO_DIR };
  }
  return getRepos().find((r) => r.alias === alias);
}


// ─── Auth ───

export function getAuthPassword(): string | null {
  if (!existsSync(AUTH_PASSWORD_FILE)) return null;
  return readFileSync(AUTH_PASSWORD_FILE, "utf-8").trim() || null;
}

export function setAuthPassword(password: string): void {
  ensureConfigDir();
  writeFileSync(AUTH_PASSWORD_FILE, password.trim());
}

// ─── Ngrok basic auth ───

export function getNgrokBasicAuth(): string | null {
  if (!existsSync(NGROK_BASIC_AUTH_FILE)) return null;
  return readFileSync(NGROK_BASIC_AUTH_FILE, "utf-8").trim() || null;
}

export function setNgrokBasicAuth(value: string): void {
  ensureConfigDir();
  writeFileSync(NGROK_BASIC_AUTH_FILE, value.trim());
}

export function deleteNgrokBasicAuth(): void {
  if (existsSync(NGROK_BASIC_AUTH_FILE)) unlinkSync(NGROK_BASIC_AUTH_FILE);
}

// ─── Session metadata ───

export function getSessionMeta(sessionName: string): WorktreeMeta[] {
  const metaFile = join(SESSIONS_DIR, sessionName);
  if (!existsSync(metaFile)) return [];
  const content = readFileSync(metaFile, "utf-8");
  const metas: WorktreeMeta[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [repoPath, wtDir] = trimmed.split("|");
    if (repoPath && wtDir) {
      metas.push({ repoPath, wtDir });
    }
  }
  return metas;
}

export function getAllSessionMetas(): Record<string, WorktreeMeta[]> {
  if (!existsSync(SESSIONS_DIR)) return {};
  const result: Record<string, WorktreeMeta[]> = {};
  for (const file of readdirSync(SESSIONS_DIR)) {
    result[file] = getSessionMeta(file);
  }
  return result;
}

export function saveWorktreeMeta(
  sessionName: string,
  repoPath: string,
  wtDir: string,
): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  appendFileSync(join(SESSIONS_DIR, sessionName), `${repoPath}|${wtDir}\n`);
}

export function deleteSessionMeta(sessionName: string): void {
  const metaFile = join(SESSIONS_DIR, sessionName);
  if (existsSync(metaFile)) unlinkSync(metaFile);
}

// ─── Session agent type ───

export function getSessionAgentType(sessionName: string): string | null {
  const agentFile = join(SESSIONS_DIR, `${sessionName}.agent`);
  if (!existsSync(agentFile)) return null;
  return readFileSync(agentFile, "utf-8").trim() || null;
}

export function saveSessionAgentType(sessionName: string, agentType: string): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(join(SESSIONS_DIR, `${sessionName}.agent`), agentType);
}

export function deleteSessionAgentType(sessionName: string): void {
  const agentFile = join(SESSIONS_DIR, `${sessionName}.agent`);
  if (existsSync(agentFile)) unlinkSync(agentFile);
}

// ─── Session type ───

export function getSessionType(sessionName: string): string | null {
  const file = join(SESSIONS_DIR, `${sessionName}.type`);
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf-8").trim() || null;
}

export function saveSessionType(sessionName: string, type: string): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(join(SESSIONS_DIR, `${sessionName}.type`), type);
}

export function deleteSessionType(sessionName: string): void {
  const file = join(SESSIONS_DIR, `${sessionName}.type`);
  if (existsSync(file)) unlinkSync(file);
}

// ─── Session skip permissions ───

export function getSessionSkipPerms(sessionName: string): boolean {
  const file = join(SESSIONS_DIR, `${sessionName}.skip-perms`);
  return existsSync(file);
}

export function saveSessionSkipPerms(sessionName: string, skip: boolean): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const file = join(SESSIONS_DIR, `${sessionName}.skip-perms`);
  if (skip) {
    writeFileSync(file, "1");
  } else if (existsSync(file)) {
    unlinkSync(file);
  }
}

export function deleteSessionSkipPerms(sessionName: string): void {
  const file = join(SESSIONS_DIR, `${sessionName}.skip-perms`);
  if (existsSync(file)) unlinkSync(file);
}

// ─── Session parent-child (sub-agents) ───

export function saveSessionParent(childName: string, parentName: string): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(join(SESSIONS_DIR, `${childName}.parent`), parentName);
}

export function getSessionParent(sessionName: string): string | null {
  const file = join(SESSIONS_DIR, `${sessionName}.parent`);
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf-8").trim() || null;
}

export function getSessionChildren(sessionName: string): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const children: string[] = [];
  for (const file of readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith(".parent")) continue;
    const content = readFileSync(join(SESSIONS_DIR, file), "utf-8").trim();
    if (content === sessionName) {
      children.push(file.replace(/\.parent$/, ""));
    }
  }
  return children;
}

export function deleteSessionParent(sessionName: string): void {
  const file = join(SESSIONS_DIR, `${sessionName}.parent`);
  if (existsSync(file)) unlinkSync(file);
}

export function getNextChildIndex(parentName: string): number {
  const children = getSessionChildren(parentName);
  if (children.length === 0) return 1;
  const indices = children
    .map((c) => {
      const match = c.match(/-sub-(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter((n) => n > 0);
  return indices.length > 0 ? Math.max(...indices) + 1 : children.length + 1;
}

// ─── Session sub-agents enabled ───

export function saveSessionSubAgents(sessionName: string, enabled: boolean): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const file = join(SESSIONS_DIR, `${sessionName}.sub-agents`);
  if (enabled) {
    writeFileSync(file, "1");
  } else if (existsSync(file)) {
    unlinkSync(file);
  }
}

export function getSessionSubAgents(sessionName: string): boolean {
  const file = join(SESSIONS_DIR, `${sessionName}.sub-agents`);
  return existsSync(file);
}

export function deleteSessionSubAgents(sessionName: string): void {
  const file = join(SESSIONS_DIR, `${sessionName}.sub-agents`);
  if (existsSync(file)) unlinkSync(file);
}

// ─── Session claude-named flag ───

export function isSessionClaudeNamed(sessionName: string): boolean {
  return existsSync(join(SESSIONS_DIR, `${sessionName}.claude-named`));
}

export function markSessionClaudeNamed(sessionName: string): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(join(SESSIONS_DIR, `${sessionName}.claude-named`), "1");
}

export function deleteSessionClaudeNamed(sessionName: string): void {
  const file = join(SESSIONS_DIR, `${sessionName}.claude-named`);
  if (existsSync(file)) unlinkSync(file);
}

// ─── Known session names (for detecting orphaned sessions after reboot) ───

export function getKnownSessionNames(): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const names = new Set<string>();
  const knownExtensions = /\.(agent|meta|skip-perms|type|parent|sub-agents|claude-named)$/;
  for (const file of readdirSync(SESSIONS_DIR)) {
    const base = file.replace(knownExtensions, "");
    if (base.startsWith(PREFIX + "-")) {
      names.add(base);
    }
  }
  return [...names];
}

// ─── Database shards ───

export function getDbShards(): DbShard[] {
  if (!existsSync(DB_SHARDS_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(DB_SHARDS_FILE, "utf-8"));
    if (Array.isArray(data)) return data;
  } catch { /* corrupt file */ }
  return [];
}

export function getDbShard(name: string): DbShard | undefined {
  return getDbShards().find((s) => s.name === name);
}

export function addDbShard(shard: DbShard): void {
  const shards = getDbShards();
  const existing = shards.findIndex((s) => s.name === shard.name);
  if (existing !== -1) {
    shards[existing] = shard;
  } else {
    shards.push(shard);
  }
  mkdirSync(DB_SHARDS_DIR, { recursive: true });
  writeFileSync(DB_SHARDS_FILE, JSON.stringify(shards, null, 2));
}

export function removeDbShard(name: string): void {
  const shards = getDbShards().filter((s) => s.name !== name);
  mkdirSync(DB_SHARDS_DIR, { recursive: true });
  writeFileSync(DB_SHARDS_FILE, JSON.stringify(shards, null, 2));
}

// ─── Session order ───

const SESSION_ORDER_FILE = join(CONFIG_DIR, "session-order.json");

export function getSessionOrder(): string[] {
  if (!existsSync(SESSION_ORDER_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(SESSION_ORDER_FILE, "utf-8"));
    if (Array.isArray(data)) return data;
  } catch { /* corrupt file */ }
  return [];
}

export function saveSessionOrder(order: string[]): void {
  ensureConfigDir();
  writeFileSync(SESSION_ORDER_FILE, JSON.stringify(order));
}

// ─── Plans ───

export function getPlan(sessionName: string): string | null {
  // Primary: exact match by session name
  const planFile = join(PLANS_DIR, `${sessionName}.md`);
  if (existsSync(planFile)) return readFileSync(planFile, "utf-8");

  // Fallback: find the most recently modified .md in plans dir.
  // Handles cases where Claude Code's plan mode writes to a different filename.
  if (!existsSync(PLANS_DIR)) return null;
  try {
    const { statSync } = require("fs") as typeof import("fs");
    const files = readdirSync(PLANS_DIR).filter((f) => f.endsWith(".md"));
    if (files.length === 0) return null;
    const sorted = files
      .map((f) => ({ f, mtime: statSync(join(PLANS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return readFileSync(join(PLANS_DIR, sorted[0].f), "utf-8");
  } catch {
    return null;
  }
}

// ─── Custom quick actions ───

export interface CustomAction {
  id: string;
  label: string;
  hint: string;
  prompt: string;
}

export function getCustomActions(): CustomAction[] {
  if (!existsSync(QUICK_ACTIONS_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(QUICK_ACTIONS_FILE, "utf-8"));
    if (Array.isArray(data)) return data;
  } catch { /* corrupt file */ }
  return [];
}

export function saveCustomAction(action: Omit<CustomAction, "id">): CustomAction {
  ensureConfigDir();
  const actions = getCustomActions();
  const newAction: CustomAction = {
    ...action,
    id: `custom-${Date.now().toString(36)}`,
  };
  actions.push(newAction);
  writeFileSync(QUICK_ACTIONS_FILE, JSON.stringify(actions, null, 2));
  return newAction;
}

export function deleteCustomAction(id: string): void {
  const actions = getCustomActions().filter((a) => a.id !== id);
  ensureConfigDir();
  writeFileSync(QUICK_ACTIONS_FILE, JSON.stringify(actions, null, 2));
}

// ─── MCP Servers ───

const MCP_SERVERS_FILE = join(CONFIG_DIR, "mcp-servers.json");
const MCP_SYNCED_NAMES_FILE = join(CONFIG_DIR, "mcp-synced-names.json");
const CLAUDE_CONFIG_FILE = join(HOME, ".claude.json");
const CURSOR_MCP_FILE = join(HOME, ".cursor", "mcp.json");

export function getMcpServers(): McpServer[] {
  if (!existsSync(MCP_SERVERS_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(MCP_SERVERS_FILE, "utf-8"));
    if (Array.isArray(data)) return data;
  } catch { /* corrupt file */ }
  return [];
}

function saveMcpServers(servers: McpServer[]): void {
  ensureConfigDir();
  writeFileSync(MCP_SERVERS_FILE, JSON.stringify(servers, null, 2));
}

function getSyncedNames(): string[] {
  if (!existsSync(MCP_SYNCED_NAMES_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(MCP_SYNCED_NAMES_FILE, "utf-8"));
    if (Array.isArray(data)) return data;
  } catch { /* corrupt file */ }
  return [];
}

function saveSyncedNames(names: string[]): void {
  ensureConfigDir();
  writeFileSync(MCP_SYNCED_NAMES_FILE, JSON.stringify(names));
}

function syncAgentConfigFile(filePath: string, servers: McpServer[], previousNames: string[]): void {
  let config: Record<string, any> = {};
  if (existsSync(filePath)) {
    try {
      config = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch { /* corrupt file, start fresh */ }
  }

  if (!config.mcpServers) config.mcpServers = {};

  // Remove previously-synced servers that are no longer in the canonical list
  const currentNames = new Set(servers.map((s) => s.name));
  for (const name of previousNames) {
    if (!currentNames.has(name)) {
      delete config.mcpServers[name];
    }
  }

  // Add/update current servers
  for (const server of servers) {
    const entry: Record<string, any> = {
      type: "stdio",
      command: server.command,
      args: server.args,
    };
    if (server.env && Object.keys(server.env).length > 0) {
      entry.env = server.env;
    }
    config.mcpServers[server.name] = entry;
  }

  // Ensure parent directory exists
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2));
}

export function syncMcpToAgents(): void {
  const servers = getMcpServers();
  const previousNames = getSyncedNames();

  syncAgentConfigFile(CLAUDE_CONFIG_FILE, servers, previousNames);
  syncAgentConfigFile(CURSOR_MCP_FILE, servers, previousNames);

  // Update tracked names
  saveSyncedNames(servers.map((s) => s.name));
}

export function addMcpServer(server: McpServer): void {
  const servers = getMcpServers();
  const existing = servers.findIndex((s) => s.name === server.name);
  if (existing !== -1) {
    servers[existing] = server;
  } else {
    servers.push(server);
  }
  saveMcpServers(servers);
  syncMcpToAgents();
}

export function removeMcpServer(name: string): void {
  const servers = getMcpServers().filter((s) => s.name !== name);
  saveMcpServers(servers);
  syncMcpToAgents();
}

// ─── Claude Code Hooks (status detection) ───

const CLAUDE_SETTINGS_FILE = join(HOME, ".claude", "settings.json");
const HOOK_STATUS_DIR = "/tmp/agentdock-status";
const HOOK_SCRIPT_SOURCE = resolve(__dirname, "..", "hooks", "status-hook.sh");
const HOOK_SCRIPT_DEST = join(CONFIG_DIR, "hooks", "status-hook.sh");

/**
 * Install the agentdock status hook script and inject hooks into Claude's settings.json.
 *
 * We use 5 lifecycle hooks for reliable status detection:
 *   PreToolUse       → "working"  (fires every tool call, including sub-agents — keeps status fresh)
 *   UserPromptSubmit → "working"  (user sent input)
 *   SubagentStop     → "working"  (sub-agent finished, but parent is still active)
 *   Stop             → "waiting"  (Claude finished responding)
 *   Notification     → "waiting"  (idle at prompt)
 *
 * PreToolUse is the key addition — it fires frequently during active work (even by sub-agents),
 * so the "working" status stays fresh. The Stop hook resets to "waiting" when done.
 */
export function syncHooksToClaudeSettings(): void {
  // 1. Copy hook script to a stable location
  const hooksDir = join(CONFIG_DIR, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(HOOK_SCRIPT_DEST, readFileSync(HOOK_SCRIPT_SOURCE, "utf-8"));
  chmodSync(HOOK_SCRIPT_DEST, 0o755);

  // 2. Ensure status directory exists
  mkdirSync(HOOK_STATUS_DIR, { recursive: true });

  // 3. Read current Claude settings
  let settings: Record<string, any> = {};
  if (existsSync(CLAUDE_SETTINGS_FILE)) {
    try {
      settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_FILE, "utf-8"));
    } catch { /* corrupt file */ }
  }

  if (!settings.hooks) settings.hooks = {};

  // Helper: check if our hook already exists in a hook array
  const hasOurHook = (hookArray: any[]) =>
    Array.isArray(hookArray) && hookArray.some(
      (h: any) => h.hooks?.some((hh: any) => hh.command?.includes("status-hook.sh"))
    );

  // Helper: inject a hook if not already present
  const ensureHook = (eventName: string, status: string, extra?: Record<string, any>) => {
    const hooks = settings.hooks[eventName] || [];
    if (!hasOurHook(hooks)) {
      hooks.push({
        ...extra,
        hooks: [{ type: "command", command: `${HOOK_SCRIPT_DEST} ${status}`, async: true }],
      });
      settings.hooks[eventName] = hooks;
    }
  };

  // 4. Inject hooks
  ensureHook("Stop", "waiting");
  ensureHook("Notification", "waiting", { matcher: "idle_prompt" });
  ensureHook("UserPromptSubmit", "working");
  ensureHook("PreToolUse", "working");
  ensureHook("SubagentStop", "working");

  // 5. Write back
  const settingsDir = join(HOME, ".claude");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

/**
 * Read hook-reported status for a tmux session.
 * Returns "waiting" or "working" if a recent hook status exists (within 60s),
 * or null if no hook data is available (fall back to terminal parsing).
 */
export function getHookStatus(sessionName: string): "waiting" | "working" | null {
  const statusFile = join(HOOK_STATUS_DIR, sessionName);
  if (!existsSync(statusFile)) return null;
  try {
    const data = JSON.parse(readFileSync(statusFile, "utf-8"));
    // Only trust status if it's recent (within 2 minutes).
    // PreToolUse hook fires on every tool call, keeping "working" fresh.
    // If nothing fires for 2 min, the session is likely stuck or disconnected.
    const age = Math.floor(Date.now() / 1000) - (data.ts || 0);
    if (age > 120) return null;
    if (data.status === "waiting" || data.status === "working") return data.status;
  } catch { /* corrupt file */ }
  return null;
}

/**
 * Clear hook status for a session (called on session stop).
 */
export function deleteHookStatus(sessionName: string): void {
  const statusFile = join(HOOK_STATUS_DIR, sessionName);
  if (existsSync(statusFile)) {
    try { unlinkSync(statusFile); } catch { /* ignore */ }
  }
}

// ─── Preferences ───

const PREFERENCES_FILE = join(CONFIG_DIR, "preferences.json");

export interface Preferences {
  recentRepos?: string[];
  pinnedSessions?: string[];
  theme?: string;
  fontSize?: string;
  cursorBlink?: boolean;
  scrollback?: number;
  terminalFontSize?: number;
  notificationsEnabled?: boolean;
  groupBy?: string;
  collapsedGroups?: string[];
}

export function getPreferences(): Preferences {
  if (!existsSync(PREFERENCES_FILE)) return {};
  try {
    return JSON.parse(readFileSync(PREFERENCES_FILE, "utf-8"));
  } catch { return {}; }
}

export function savePreferences(prefs: Preferences): void {
  ensureConfigDir();
  writeFileSync(PREFERENCES_FILE, JSON.stringify(prefs, null, 2));
}

// ─── Meta property presets ───

const META_PROPERTIES_FILE = join(CONFIG_DIR, "meta-properties.json");

export interface MetaPropertyPreset {
  key: string;
  label: string;
  values: string[];
}

export function getMetaPropertyPresets(): MetaPropertyPreset[] {
  if (!existsSync(META_PROPERTIES_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(META_PROPERTIES_FILE, "utf-8"));
    if (Array.isArray(data)) return data;
  } catch { /* corrupt file */ }
  return [];
}

export function saveMetaPropertyPresets(presets: MetaPropertyPreset[]): void {
  ensureConfigDir();
  writeFileSync(META_PROPERTIES_FILE, JSON.stringify(presets, null, 2));
}

// ─── Session properties (meta key-value pairs) ───

export function getSessionProperties(sessionName: string): Record<string, string> {
  const file = join(SESSIONS_DIR, `${sessionName}.meta`);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch { return {}; }
}

export function saveSessionProperties(sessionName: string, meta: Record<string, string>): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(join(SESSIONS_DIR, `${sessionName}.meta`), JSON.stringify(meta));
}

export function deleteSessionProperties(sessionName: string): void {
  const file = join(SESSIONS_DIR, `${sessionName}.meta`);
  if (existsSync(file)) unlinkSync(file);
}

// ─── Exports ───

export const PREFIX = "claude";
export const CONFIG_DIR_PATH = CONFIG_DIR;
export const SESSIONS_DIR_PATH = SESSIONS_DIR;
export const PLANS_DIR_PATH = PLANS_DIR;
export const HOME_DIR = HOME;
