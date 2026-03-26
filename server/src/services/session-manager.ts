import { createHash, createHmac } from "crypto";
import { readFileSync, mkdirSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import {
  resolveAlias,
  saveWorktreeMeta,
  getSessionMeta,
  deleteSessionMeta,
  PREFIX,
  HOME_DIR,
  saveSessionAgentType,
  getSessionAgentType,
  deleteSessionAgentType,
  saveSessionSkipPerms,
  getSessionSkipPerms,
  deleteSessionSkipPerms,
  saveSessionParent,
  getSessionParent,
  getSessionChildren,
  deleteSessionParent,
  getNextChildIndex,
  deleteSessionSubAgents,
  getAuthPassword,
  saveSessionType,
  deleteSessionType,
  getSessionOrder,
  saveSessionOrder,
  deleteHookStatus,
  deleteSessionProperties,
  getSessionProperties,
  isSessionClaudeNamed,
  markSessionClaudeNamed,
  deleteSessionClaudeNamed,
} from "./config";
import * as tmux from "./tmux";
import * as worktree from "./worktree";
import { fetchTicket, buildTicketPrompt } from "./linear";
import type { CreateSessionRequest, LinearTicket, AgentType } from "../types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Bash(git:*)",
  "Bash(gh:*)",
  "Bash(grep:*)",
  "Bash(rg:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(ls:*)",
  "Bash(find:*)",
  "Bash(wc:*)",
  "Bash(go:*)",
  "Bash(make:*)",
  "Bash(npm:*)",
  "Bash(bun:*)",
  "Bash(npx:*)",
  "Bash(ad-agent:*)",
];

const PROMPT_DIR = "/tmp/agentdock-prompts";
const SYSTEM_PROMPT_DIR = "/tmp/agentdock-system-prompts";
const PLANS_DIR = `${HOME_DIR}/.config/agentdock/plans`;
const SYSTEM_PROMPT_TEMPLATE = join(__dirname, "..", "prompts", "system-prompt.md");

function buildSystemInstructions(sessionName: string): string {
  const template = readFileSync(SYSTEM_PROMPT_TEMPLATE, "utf-8");
  return template
    .replace(/\{\{PLANS_DIR\}\}/g, PLANS_DIR)
    .replace(/\{\{SESSION_NAME\}\}/g, sessionName);
}

export function writeSystemPromptFile(sessionName: string, meta?: Record<string, string>): string {
  mkdirSync(SYSTEM_PROMPT_DIR, { recursive: true });
  const filePath = `${SYSTEM_PROMPT_DIR}/${sessionName}.txt`;
  let content = buildSystemInstructions(sessionName);
  if (meta && Object.keys(meta).length > 0) {
    content += "\n\n## Session Context\n\nThis session has the following metadata properties:\n";
    for (const [key, value] of Object.entries(meta)) {
      content += `- **${key}**: ${value}\n`;
    }
  }
  writeFileSync(filePath, content);
  return filePath;
}

function writePromptFile(sessionName: string, prompt: string): string {
  mkdirSync(PROMPT_DIR, { recursive: true });
  const promptFile = `${PROMPT_DIR}/${sessionName}.txt`;
  writeFileSync(promptFile, prompt);
  return promptFile;
}

export function buildAgentCmd(agentType: AgentType, dangerouslySkipPermissions?: boolean, systemPromptFile?: string, addDirs?: string[], claudeSessionName?: string): string {
  if (agentType === "cursor") {
    return dangerouslySkipPermissions ? "agent --yolo" : "agent";
  }

  // Claude agent command
  let cmd: string;
  if (dangerouslySkipPermissions) {
    cmd = "claude --dangerously-skip-permissions";
  } else {
    const tools = ALLOWED_TOOLS.map((t) => t.includes("(") ? `'${t}'` : t).join(" ");
    cmd = `claude --allowedTools ${tools}`;
  }
  if (systemPromptFile) {
    cmd += ` --append-system-prompt-file ${systemPromptFile}`;
  }
  if (addDirs && addDirs.length > 0) {
    cmd += ` --add-dir ${addDirs.join(" --add-dir ")}`;
  }
  if (claudeSessionName) {
    cmd += ` -n "${claudeSessionName}"`;
  }
  return cmd;
}

function shortId(): string {
  return createHash("sha1")
    .update(Date.now().toString())
    .digest("hex")
    .slice(0, 6);
}

export function sessionNameFromTarget(target: string): string {
  const name = target.replace(/:/g, "-").replace(/\//g, "-");
  return `${PREFIX}-${name}`;
}

export interface ParsedPiece {
  alias: string;
  branch: string;
}

export function parsePiece(piece: string): ParsedPiece {
  const colonIdx = piece.indexOf(":");
  if (colonIdx !== -1) {
    return {
      alias: piece.slice(0, colonIdx),
      branch: piece.slice(colonIdx + 1),
    };
  }
  return { alias: piece, branch: "" };
}

async function resolvePiece(
  piece: string,
  newBranch?: string,
  sessionSlug?: string,
): Promise<{
  workDir: string;
  repoPath: string;
  isWorktree: boolean;
}> {
  const { alias, branch } = parsePiece(piece);
  const repo = resolveAlias(alias);
  if (!repo) throw new Error(`Unknown alias: ${alias}`);

  if (branch) {
    const opts = sessionSlug ? { sessionSlug, repoAlias: alias } : undefined;
    const wtDir = await worktree.createWorktree(
      repo.path,
      branch,
      newBranch || undefined,
      opts,
    );
    return { workDir: wtDir, repoPath: repo.path, isWorktree: true };
  }

  return { workDir: repo.path, repoPath: repo.path, isWorktree: false };
}

async function launchAgent(
  sess: string,
  cwd: string,
  agentType: AgentType,
  prompt?: string,
  dangerouslySkipPermissions?: boolean,
  parentSession?: string,
  addDirs?: string[],
  meta?: Record<string, string>,
): Promise<void> {

  // Pass env vars via tmux's -e flag so they are set BEFORE the shell starts.
  // This avoids race conditions with shell init (oh-my-zsh prompts, plugins, etc.)
  // and guarantees the vars are inherited by all child processes.
  const parentName = parentSession || sess;
  const sessionEnv: Record<string, string> = {
    AD_AGENT_PARENT: parentName,
    AGENTDOCK_SERVER: "http://localhost:4800",
    DISABLE_UPDATE_PROMPT: "true", // suppress oh-my-zsh update prompt
    NO_COLOR: "", // override NO_COLOR from tmux global env so agents render with colors
    COLORTERM: "truecolor", // enable 24-bit color support
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1", // enable team lead / agent teams
  };
  // Compute auth token so ad-agent can authenticate with the server
  const authPassword = getAuthPassword();
  if (authPassword) {
    sessionEnv.AD_AUTH_TOKEN = createHash("sha256").update(`ad:${authPassword}`).digest("hex");
  }
  await tmux.createSession(sess, cwd, sessionEnv);
  await tmux.setOption(sess, "extended-keys", "on");

  // Write system prompt file with agentdock instructions (plan saving, PR monitoring, etc.)
  // For Claude, this is injected via --append-system-prompt-file so it's always present
  const systemPromptFile = writeSystemPromptFile(sess, meta);

  // Wait for shell init to complete before sending commands
  const displayName = sess.replace(`${PREFIX}-`, "");
  await sleep(2000);
  await tmux.sendKeys(sess, buildAgentCmd(agentType, dangerouslySkipPermissions, systemPromptFile, addDirs, agentType === "claude" ? displayName : undefined));

  // Save session metadata
  saveSessionAgentType(sess, agentType);
  saveSessionSkipPerms(sess, !!dangerouslySkipPermissions);
  if (agentType === "claude") markSessionClaudeNamed(sess);

  if (prompt) {
    const promptFile = writePromptFile(sess, prompt);
    console.log(`[launch] ${sess}: prompt written to ${promptFile} (${prompt.length} chars)`);
    // Wait for agent to show trust prompt (if any), accept it, then wait for full boot
    await sleep(2000);
    if (agentType === "claude") {
      await tmux.sendSpecialKey(sess, "Enter"); // accept trust prompt for Claude
    }
    await sleep(3000);

    if (agentType === "cursor") {
      await tmux.sendKeysRaw(sess, `Follow the instructions in ${promptFile}`);
    } else {
      await tmux.sendKeysRaw(sess, `Read and follow the instructions in ${promptFile}`);
    }
    await tmux.sendSpecialKey(sess, "Enter");
    console.log(`[launch] ${sess}: prompt sent to agent`);
  } else {
    console.log(`[launch] ${sess}: no prompt, system instructions via --append-system-prompt-file`);
  }
}

export async function startSession(req: CreateSessionRequest): Promise<string[]> {
  let targets = [...req.targets];
  let prompt = req.prompt || "";
  let isolated = req.isolated || false;
  let newBranch = req.newBranch || "";
  let ticket: LinearTicket | null = null;
  let agentType: AgentType = req.agentType || "claude"; // Default to Claude for backward compatibility

  // --ticket: fetch Linear ticket, set isolated + new-branch + prompt
  if (req.ticket) {
    console.log(`[ticket] Fetching ticket ${req.ticket}...`);
    ticket = await fetchTicket(req.ticket);
    if (!ticket) throw new Error(`Ticket '${req.ticket}' not found in Linear`);
    console.log(`[ticket] Found: ${ticket.identifier} — ${ticket.title}`);
    isolated = true;
    if (!newBranch) newBranch = "main";
    if (!prompt) prompt = buildTicketPrompt(ticket);
    console.log(`[ticket] Prompt length: ${prompt.length}`);
  }

  // --isolated: generate worktree branch for every target
  let sessionSlug: string | undefined;
  if (isolated) {
    if (!newBranch) newBranch = "main";

    let wtBranch: string;
    if (req.ticket) {
      wtBranch = req.ticket;
    } else {
      // Use a short ID for the worktree branch — Claude can rename/create
      // the real branch as part of its workflow (e.g., based on Linear ticket)
      wtBranch = `wt-${shortId()}`;
    }

    // Derive sessionSlug from wtBranch so they always match
    sessionSlug = wtBranch.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();

    targets = targets.map((t) => {
      if (t.includes(":")) return t;
      return `${t}:${wtBranch}`;
    });
  }

  // --grouped: merge all targets into single grouped target
  if (req.grouped && targets.length > 1) {
    targets = [targets.join("+")];
  }

  const createdSessions: string[] = [];

  // If this is a sub-agent, auto-name based on parent
  if (req.parentSession && !req.name) {
    const idx = getNextChildIndex(req.parentSession);
    req.name = `${req.parentSession.replace(`${PREFIX}-`, "")}-sub-${idx}`;
  }

  // Ticket actions require at least one repo target for worktree isolation
  if (targets.length === 0 && req.ticket) {
    throw new Error("Select at least one repository for ticket sessions");
  }

  // No repos selected — launch a plain agent session in ~/projects
  if (targets.length === 0) {
    const sess = req.name
      ? `${PREFIX}-${req.name.replace(/[^a-zA-Z0-9_-]/g, "-")}`
      : `${PREFIX}-${shortId()}`;

    if (!(await tmux.hasSession(sess))) {
      await launchAgent(sess, `${HOME_DIR}/projects`, agentType, prompt || undefined, req.dangerouslySkipPermissions, req.parentSession, undefined, req.meta);
      if (req.parentSession) saveSessionParent(sess, req.parentSession);
      if (req.sessionType) saveSessionType(sess, req.sessionType);
    }
    return [sess];
  }

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    let sess: string;
    if (req.name) {
      const safeName = req.name.replace(/[^a-zA-Z0-9_-]/g, "-");
      sess = targets.length === 1
        ? `${PREFIX}-${safeName}`
        : `${PREFIX}-${safeName}-${i + 1}`;
    } else {
      sess = sessionNameFromTarget(target);
    }

    if (await tmux.hasSession(sess)) {
      if (prompt) {
        // Session exists but we have a prompt to send — create a new session with unique suffix
        sess = `${sess}-${Date.now().toString(36).slice(-4)}`;
        console.log(`[session] Original session existed, created unique name: ${sess}`);
      } else {
        console.log(`[session] ${sess} already exists, reusing`);
        createdSessions.push(sess);
        continue;
      }
    }

    if (target.includes("+")) {
      // Grouped multi-repo
      const pieces = target.split("+");
      const workDirs: string[] = [];

      for (const piece of pieces) {
        const resolved = await resolvePiece(piece, newBranch, sessionSlug);
        workDirs.push(resolved.workDir);
        if (resolved.isWorktree) {
          saveWorktreeMeta(sess, resolved.repoPath, resolved.workDir);
        }
      }

      // For isolated sessions, use the first worktree as the primary working directory
      // so the agent starts in an actual repo (not the parent workspace dir)
      const sessionDir = sessionSlug
        ? workDirs[0]
        : workDirs.length === 1 ? workDirs[0] : `${HOME_DIR}/projects`;

      // For multi-repo sessions, pass additional dirs via --add-dir
      const additionalDirs = workDirs.length > 1 ? workDirs.slice(1) : undefined;

      // Build repo context with explicit directory paths
      let fullPrompt = prompt || undefined;
      if (workDirs.length > 1) {
        let repoContext = "You are working across multiple repositories. Each repo is in its own directory:\n";
        for (const wd of workDirs) {
          const repoName = wd.split("/").pop() || wd;
          repoContext += `  - ${repoName}: ${wd}\n`;
        }
        repoContext += `\nYour current working directory is: ${workDirs[0]}\n`;
        repoContext += `When you need to work on a different repo, cd into its directory.\n`;
        if (prompt) {
          fullPrompt = repoContext + "\n" + prompt;
        } else {
          repoContext += `\nThis is your working environment. Do NOT start any work yet — wait for the user to assign you a task.\n`;
          repoContext += `Introduce yourself briefly, list the repos you have access to, and ask what the user would like you to work on.\n`;
          fullPrompt = repoContext;
        }
      }

      await launchAgent(sess, sessionDir, agentType, fullPrompt, req.dangerouslySkipPermissions, req.parentSession, additionalDirs, req.meta);
    } else {
      // Single repo
      const resolved = await resolvePiece(target, newBranch, sessionSlug);
      if (resolved.isWorktree) {
        saveWorktreeMeta(sess, resolved.repoPath, resolved.workDir);
      }

      await launchAgent(sess, resolved.workDir, agentType, prompt || undefined, req.dangerouslySkipPermissions, req.parentSession, undefined, req.meta);
    }

    // Save parent-child relationship if this is a sub-agent
    if (req.parentSession) saveSessionParent(sess, req.parentSession);
    if (req.sessionType) saveSessionType(sess, req.sessionType);

    createdSessions.push(sess);
  }

  return createdSessions;
}

export async function stopSession(sessionName: string): Promise<void> {
  // Stop all child sessions first
  const children = getSessionChildren(sessionName);
  for (const child of children) {
    try {
      await stopSession(child);
    } catch {
      // Best effort cleanup of children
    }
  }

  // Kill tmux session
  if (await tmux.hasSession(sessionName)) {
    await tmux.killSession(sessionName);
  }

  // Clean up worktrees
  const metas = getSessionMeta(sessionName);
  for (const meta of metas) {
    try {
      await worktree.removeWorktree(meta.repoPath, meta.wtDir);
    } catch {
      // Best effort cleanup
    }
  }

  // Clean up session workspace directory (for isolated sessions)
  const slug = sessionName.replace(`${PREFIX}-`, "");
  try {
    await worktree.removeSessionWorkspace(slug);
  } catch {
    // Best effort cleanup
  }

  // Remove metadata files
  deleteSessionMeta(sessionName);
  deleteSessionAgentType(sessionName);
  deleteSessionSkipPerms(sessionName);
  deleteSessionParent(sessionName);
  deleteSessionSubAgents(sessionName);
  deleteSessionType(sessionName);
  deleteSessionProperties(sessionName);
  deleteSessionClaudeNamed(sessionName);

  // Remove from session order
  const order = getSessionOrder();
  const filtered = order.filter((n) => n !== sessionName);
  if (filtered.length !== order.length) {
    saveSessionOrder(filtered);
  }

  // Remove hook status file
  deleteHookStatus(sessionName);
}

export async function stopAllSessions(): Promise<void> {
  const sessions = await tmux.listSessions(PREFIX);
  for (const session of sessions) {
    await stopSession(session.name);
  }
}

function findLatestClaudeSessionUuid(wtDir: string): string | null {
  try {
    // Claude encodes the project path by replacing '/' and '.' with '-'
    const encoded = wtDir.replace(/[/.]/g, "-");
    const claudeProjectDir = join(HOME_DIR, ".claude", "projects", encoded);
    const files = readdirSync(claudeProjectDir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) return null;
    const withStats = files.map((f) => ({
      uuid: f.replace(".jsonl", ""),
      mtime: statSync(join(claudeProjectDir, f)).mtimeMs,
    }));
    withStats.sort((a, b) => b.mtime - a.mtime);
    return withStats[0].uuid;
  } catch {
    return null;
  }
}

export async function restoreSession(sessionName: string): Promise<void> {
  if (await tmux.hasSession(sessionName)) {
    throw new Error(`Session ${sessionName} is already running`);
  }

  const agentType = (getSessionAgentType(sessionName) as AgentType) || "claude";
  if (agentType !== "claude") {
    throw new Error(`Resume is only supported for Claude sessions (agent: ${agentType})`);
  }

  const metas = getSessionMeta(sessionName);
  const cwd = metas.length > 0 ? metas[0].wtDir : `${HOME_DIR}/projects`;
  const skipPerms = getSessionSkipPerms(sessionName);
  const meta = getSessionProperties(sessionName);
  const displayName = sessionName.replace(`${PREFIX}-`, "");
  const parentSession = getSessionParent(sessionName) || sessionName;

  const sessionEnv: Record<string, string> = {
    AD_AGENT_PARENT: parentSession,
    AGENTDOCK_SERVER: "http://localhost:4800",
    DISABLE_UPDATE_PROMPT: "true",
    NO_COLOR: "",
    COLORTERM: "truecolor",
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
  };
  const authPassword = getAuthPassword();
  if (authPassword) {
    sessionEnv.AD_AUTH_TOKEN = createHash("sha256").update(`ad:${authPassword}`).digest("hex");
  }

  await tmux.createSession(sessionName, cwd, sessionEnv);
  await tmux.setOption(sessionName, "extended-keys", "on");

  const systemPromptFile = writeSystemPromptFile(sessionName, Object.keys(meta).length > 0 ? meta : undefined);

  await sleep(2000);

  // Build resume command: --resume <name> resumes Claude conversation history
  let cmd: string;
  if (skipPerms) {
    cmd = "claude --dangerously-skip-permissions";
  } else {
    const tools = ALLOWED_TOOLS.map((t) => t.includes("(") ? `'${t}'` : t).join(" ");
    cmd = `claude --allowedTools ${tools}`;
  }
  cmd += ` --append-system-prompt-file ${systemPromptFile}`;
  // Pass UUID directly to bypass the interactive TUI session picker (which can freeze)
  const sessionUuid = findLatestClaudeSessionUuid(cwd);
  if (sessionUuid) {
    cmd += ` --resume ${sessionUuid}`;
  } else {
    cmd += ` --resume "${displayName}"`;
  }

  await tmux.sendKeys(sessionName, cmd);

  // Accept trust prompt (if any) then mark as named
  await sleep(2000);
  await tmux.sendSpecialKey(sessionName, "Enter");
  markSessionClaudeNamed(sessionName);

  console.log(`[restore] ${sessionName}: resumed with uuid=${sessionUuid ?? `name:${displayName}`}`);
}

export async function migrateUnnamedSessions(): Promise<void> {
  const liveSessions = await tmux.listSessions(PREFIX);
  for (const s of liveSessions) {
    const agentType = getSessionAgentType(s.name);
    if (agentType !== "claude" && agentType !== null) continue;
    if (isSessionClaudeNamed(s.name)) continue;
    const displayName = s.name.replace(`${PREFIX}-`, "");
    console.log(`[migrate] Naming session ${s.name} as "${displayName}"`);
    try {
      await tmux.sendKeysRaw(s.name, `/rename "${displayName}"`);
      await tmux.sendSpecialKey(s.name, "Enter");
      markSessionClaudeNamed(s.name);
    } catch (err) {
      console.warn(`[migrate] Failed to rename ${s.name}:`, err);
    }
  }
}
