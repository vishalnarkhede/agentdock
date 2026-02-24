import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, appendFileSync } from "fs";
import { join } from "path";
import type { RepoConfig, WorktreeMeta, DbShard } from "../types";

import { homedir } from "os";

const HOME = process.env.HOME || homedir();
const CONFIG_DIR = join(HOME, ".config", "agentdock");
const REPOS_FILE = join(CONFIG_DIR, "repos.json");
const BASE_PATH_FILE = join(CONFIG_DIR, "base-path");
const LINEAR_KEY_FILE = join(CONFIG_DIR, "linear-api-key");
const SLACK_TOKEN_FILE = join(CONFIG_DIR, "slack-token");
const LINEAR_TEAM_ID_FILE = join(CONFIG_DIR, "linear-team-id");
const AUTH_PASSWORD_FILE = join(CONFIG_DIR, "auth-password");
const DB_SHARDS_DIR = join(CONFIG_DIR, "db-shards");
const DB_SHARDS_FILE = join(DB_SHARDS_DIR, "shards.json");
const SESSIONS_DIR = join(CONFIG_DIR, "sessions");
const PLANS_DIR = join(CONFIG_DIR, "plans");

// No legacy repos — configure repos via the web UI or repos.json

function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

// ─── Base path ───

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

export function hasReposFile(): boolean {
  return existsSync(REPOS_FILE);
}

export function resolveAlias(alias: string): RepoConfig | undefined {
  return getRepos().find((r) => r.alias === alias);
}

// ─── Integration keys ───

export function getLinearApiKey(): string | null {
  if (!existsSync(LINEAR_KEY_FILE)) return null;
  return readFileSync(LINEAR_KEY_FILE, "utf-8").trim();
}

export function setLinearApiKey(key: string): void {
  ensureConfigDir();
  writeFileSync(LINEAR_KEY_FILE, key.trim());
}

export function deleteLinearApiKey(): void {
  if (existsSync(LINEAR_KEY_FILE)) unlinkSync(LINEAR_KEY_FILE);
}

export function getSlackToken(): string | null {
  if (!existsSync(SLACK_TOKEN_FILE)) return null;
  return readFileSync(SLACK_TOKEN_FILE, "utf-8").trim();
}

export function setSlackToken(token: string): void {
  ensureConfigDir();
  writeFileSync(SLACK_TOKEN_FILE, token.trim());
}

export function deleteSlackToken(): void {
  if (existsSync(SLACK_TOKEN_FILE)) unlinkSync(SLACK_TOKEN_FILE);
}

export function getLinearTeamId(): string | null {
  if (!existsSync(LINEAR_TEAM_ID_FILE)) return null;
  return readFileSync(LINEAR_TEAM_ID_FILE, "utf-8").trim();
}

export function setLinearTeamId(id: string): void {
  ensureConfigDir();
  writeFileSync(LINEAR_TEAM_ID_FILE, id.trim());
}

export function deleteLinearTeamId(): void {
  if (existsSync(LINEAR_TEAM_ID_FILE)) unlinkSync(LINEAR_TEAM_ID_FILE);
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
  const planFile = join(PLANS_DIR, `${sessionName}.md`);
  if (!existsSync(planFile)) return null;
  return readFileSync(planFile, "utf-8");
}

// ─── Exports ───

export const PREFIX = "claude";
export const CONFIG_DIR_PATH = CONFIG_DIR;
export const SESSIONS_DIR_PATH = SESSIONS_DIR;
export const PLANS_DIR_PATH = PLANS_DIR;
export const HOME_DIR = HOME;
