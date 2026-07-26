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
  getKnownSessionNames,
  isSessionClaudeNamed,
  markSessionClaudeNamed,
  deleteSessionClaudeNamed,
  PLANS_DIR_PATH,
} from "./config";
import * as tmux from "./tmux";
import * as worktree from "./worktree";
import { killShellSessions } from "./shell-sessions";
import { spawnTool } from "./spawn";
import type { CreateSessionRequest, AgentType, WorktreeMode } from "../types";

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
const SYSTEM_PROMPT_TEMPLATE = join(__dirname, "..", "prompts", "system-prompt.md");

function buildSystemInstructions(sessionName: string): string {
  const template = readFileSync(SYSTEM_PROMPT_TEMPLATE, "utf-8");
  // PLANS_DIR_PATH, not a local constant: the agent must be told the same
  // directory getPlan() reads, which follows AGENTDOCK_CONFIG_DIR.
  return template
    .replace(/\{\{PLANS_DIR\}\}/g, PLANS_DIR_PATH)
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

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function agentdockServerUrl(): string {
  const port = process.env.PORT || process.env.SERVER_PORT || "4800";
  const host = process.env.AGENTDOCK_HOST || "127.0.0.1";
  const displayHost = host === "0.0.0.0" || host === "127.0.0.1" ? "localhost" : host;
  return `http://${displayHost}:${port}`;
}

// Runs as tmux new-session's command, so the agent starts directly and no
// interactive shell is around to swallow the launch command.
//
// The exec is load-bearing, not style: it makes the agent the pane's own process,
// so tmux reports "claude"/"codex"/"agent" as #{pane_current_command}. Without it
// the pane reports the shell, and isAgentCommand() — which drives
// sessionHasAgentPane(), external-pane discovery, and the shell branch of
// detectStatus() — stops recognising the pane as an agent at all.
//
// Surviving a failed launch is handled by remain-on-exit in createSession, not by
// keeping a shell in front of the agent.
function asInitialAgentCommand(command: string): string {
  return `exec ${command}`;
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

function promptTail(content: string): string {
  return stripAnsi(content)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-30)
    .join("\n");
}

async function capturePromptTail(sess: string): Promise<string> {
  const snap = await tmux.capturePaneSnapshot(sess);
  return snap.ok ? promptTail(snap.data.content) : "";
}

async function waitForClaudeStartupPrompt(sess: string): Promise<string> {
  let content = "";
  for (let i = 0; i < 12; i++) {
    content = await capturePromptTail(sess);
    if (/Bypass Permissions mode|Quick safety check|trust this folder/i.test(content)) {
      return content;
    }
    await sleep(500);
  }
  return content;
}

async function acceptClaudeStartupPrompts(sess: string, skipPermissions?: boolean): Promise<void> {
  let content = await waitForClaudeStartupPrompt(sess);

  if (skipPermissions && /Bypass Permissions mode/i.test(content)) {
    await tmux.sendKeysRaw(sess, "2");
    await tmux.sendSpecialKey(sess, "Enter");
    await sleep(1500);
    content = await waitForClaudeStartupPrompt(sess);
  }

  if (/Quick safety check|trust this folder/i.test(content)) {
    await tmux.sendSpecialKey(sess, "Enter");
  }
}

export function buildAgentCmd(agentType: AgentType, dangerouslySkipPermissions?: boolean, systemPromptFile?: string, addDirs?: string[], claudeSessionName?: string): string {
  if (agentType === "cursor") {
    return dangerouslySkipPermissions ? "agent --yolo" : "agent";
  }

  if (agentType === "codex") {
    let cmd = dangerouslySkipPermissions ? "codex --dangerously-bypass-approvals-and-sandbox" : "codex";
    if (addDirs && addDirs.length > 0) {
      cmd += ` ${addDirs.map((dir) => `--add-dir ${shellQuote(dir)}`).join(" ")}`;
    }
    if (systemPromptFile) {
      cmd += ` ${shellQuote(`Read and follow the Agentdock session instructions in ${systemPromptFile}.`)}`;
    }
    return cmd;
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
    .update(`${Date.now()}-${Math.random()}`)
    .digest("hex")
    .slice(0, 6);
}

function sessionNameSlug(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || shortId();
}

async function isSessionNameUsed(name: string): Promise<boolean> {
  return (await tmux.hasSession(name)) || getKnownSessionNames().includes(name);
}

async function uniqueSessionName(base: string): Promise<string> {
  if (!(await isSessionNameUsed(base))) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!(await isSessionNameUsed(candidate))) return candidate;
  }
  return `${base}-${shortId()}`;
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
  managedWorktree: boolean;
}> {
  const { alias, branch } = parsePiece(piece);
  const repo = resolveAlias(alias);
  if (!repo) throw new Error(`Unknown alias: ${alias}`);

  if (branch) {
    const opts = sessionSlug ? { sessionSlug, repoAlias: alias } : undefined;
    const sourceRepoPath = await worktree.getSourceRepoPath(repo.path);
    const wtDir = await worktree.createWorktree(
      repo.path,
      branch,
      newBranch || undefined,
      opts,
    );
    return { workDir: wtDir, repoPath: sourceRepoPath, isWorktree: true, managedWorktree: true };
  }

  return { workDir: repo.path, repoPath: repo.path, isWorktree: false, managedWorktree: false };
}

async function checkAgentInstalled(agentType: AgentType): Promise<void> {
  const cmd = agentType === "cursor" ? "agent" : agentType;
  try {
    const proc = spawnTool(cmd, ["--version"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      // Version command failed — still probably installed; proceed
    }
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.errno === -2) {
      if (agentType === "cursor") {
        throw new Error(
          "Cursor agent CLI is not installed. Install the Cursor IDE from cursor.com, then enable the agent CLI."
        );
      }
      if (agentType === "codex") {
        throw new Error(
          "Codex CLI is not installed. Install it with Homebrew or npm, then run `codex login`."
        );
      }
      throw new Error(
        "Claude Code is not installed. Install it with:\n  npm install -g @anthropic-ai/claude-code\n  or visit: https://claude.ai/code"
      );
    }
    // Other errors (permission denied, etc.) — let it proceed and fail naturally
  }
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
  await checkAgentInstalled(agentType);

  // Pass env vars via tmux's -e flag so they are set BEFORE the shell starts.
  // This avoids race conditions with shell init (oh-my-zsh prompts, plugins, etc.)
  // and guarantees the vars are inherited by all child processes.
  const parentName = parentSession || sess;
  const sessionEnv: Record<string, string> = {
    AD_AGENT_PARENT: parentName,
    AGENTDOCK_SERVER: agentdockServerUrl(),
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
  // Write system prompt file before creating the tmux session so the agent can
  // start directly. This avoids interactive shell startup prompts stealing the
  // launch command before Claude/Codex/Cursor ever starts.
  const systemPromptFile = writeSystemPromptFile(sess, meta);
  const displayName = sess.replace(`${PREFIX}-`, "");
  const agentCmd = buildAgentCmd(agentType, dangerouslySkipPermissions, systemPromptFile, addDirs, agentType === "claude" ? displayName : undefined);
  await tmux.createSession(sess, cwd, sessionEnv, asInitialAgentCommand(agentCmd));
  await tmux.setOption(sess, "extended-keys", "on");

  // Save session metadata
  saveSessionAgentType(sess, agentType);
  saveSessionSkipPerms(sess, !!dangerouslySkipPermissions);
  if (agentType === "claude") markSessionClaudeNamed(sess);

  if (agentType === "claude") {
    await acceptClaudeStartupPrompts(sess, dangerouslySkipPermissions);
  }

  if (prompt) {
    const promptFile = writePromptFile(sess, prompt);
    console.log(`[launch] ${sess}: prompt written to ${promptFile} (${prompt.length} chars)`);
    // Wait for the TUI to settle before sending the initial task.
    await sleep(agentType === "claude" ? 3000 : 5000);

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

function resolveRequestedWorktreeMode(req: CreateSessionRequest): { mode: WorktreeMode; base?: string } {
  if (req.worktreeMode) {
    switch (req.worktreeMode) {
      case "direct":
        return { mode: "direct" };
      case "fresh-current":
        return { mode: "fresh-current", base: "HEAD" };
      case "fresh-main":
        return { mode: "fresh-main", base: "main" };
      case "fresh-custom":
        return { mode: "fresh-custom", base: (req.worktreeBase || req.newBranch || "").trim() };
    }
  }

  if (req.isolated) {
    return req.newBranch
      ? { mode: "fresh-custom", base: req.newBranch }
      : { mode: "fresh-main", base: "main" };
  }

  return { mode: "direct" };
}

export async function startSession(req: CreateSessionRequest): Promise<string[]> {
  let targets = [...req.targets];
  let prompt = req.prompt || "";
  const requestedWorktree = resolveRequestedWorktreeMode(req);
  const isolated = requestedWorktree.mode !== "direct";
  let newBranch = requestedWorktree.base || "";
  let agentType: AgentType = req.agentType || "claude"; // Default to Claude for backward compatibility

  // Fresh worktree modes generate a temporary branch for every target.
  let sessionSlug: string | undefined;
  if (isolated) {
    if (requestedWorktree.mode === "fresh-custom" && !newBranch) {
      throw new Error("Custom worktree base is required");
    }

    // Use a short ID for the worktree branch — the agent can rename/create
    // the real branch as part of its workflow.
    const wtBranch = `wt-${shortId()}`;

    // Derive sessionSlug from wtBranch so they always match.
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

  // No repos selected — launch a plain agent session in ~/projects
  if (targets.length === 0) {
    const baseSessionName = req.name
      ? `${PREFIX}-${sessionNameSlug(req.name)}`
      : `${PREFIX}-${shortId()}`;
    let sess = req.name ? baseSessionName : await uniqueSessionName(baseSessionName);

    if (await tmux.hasSession(sess)) {
      const existingAgentType = getSessionAgentType(sess) as AgentType | null;
      const canReuseAgent = existingAgentType ? existingAgentType === agentType : agentType === "claude";
      if ((await tmux.sessionHasAgentPane(sess)) && canReuseAgent) {
        console.log(`[session] ${sess} already has a ${agentType} agent, reusing`);
        return [sess];
      }
      const replacement = await uniqueSessionName(`${sess}-${Date.now().toString(36).slice(-4)}`);
      console.log(`[session] ${sess} cannot be reused for ${agentType}, launching ${replacement} instead`);
      sess = replacement;
    }

    await launchAgent(sess, `${HOME_DIR}/projects`, agentType, prompt || undefined, req.dangerouslySkipPermissions, req.parentSession, undefined, req.meta);
    if (req.parentSession) saveSessionParent(sess, req.parentSession);
    if (req.sessionType) saveSessionType(sess, req.sessionType);
    return [sess];
  }

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    let sess: string;
    if (req.name) {
      const safeName = sessionNameSlug(req.name);
      sess = targets.length === 1
        ? `${PREFIX}-${safeName}`
        : `${PREFIX}-${safeName}-${i + 1}`;
    } else {
      sess = await uniqueSessionName(sessionNameFromTarget(target));
    }

    if (await tmux.hasSession(sess)) {
      if (prompt) {
        // Session exists but we have a prompt to send — create a new session with unique suffix
        sess = await uniqueSessionName(`${sess}-${Date.now().toString(36).slice(-4)}`);
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
          saveWorktreeMeta(sess, resolved.repoPath, resolved.workDir, resolved.managedWorktree);
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
      // Always save path metadata so the session list shows the correct repo path.
      // Only Agentdock-created worktrees are marked for cleanup on stop.
      saveWorktreeMeta(sess, resolved.repoPath, resolved.workDir, resolved.managedWorktree);

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

  // Before worktree removal: a shell sitting in a worktree holds it as its cwd,
  // and git refuses to remove a worktree that is still in use.
  await killShellSessions(sessionName);

  // Clean up only Agentdock-owned worktrees. Existing configured worktrees are
  // tracked for display/restore metadata but must not be deleted on stop.
  const metas = getSessionMeta(sessionName);
  const slug = sessionName.replace(`${PREFIX}-`, "");
  const sessionWorkspace = worktree.sessionWorkspaceDir(slug);
  const isManagedMeta = (meta: { wtDir: string; managed?: boolean }) => (
    meta.managed || meta.wtDir === sessionWorkspace || meta.wtDir.startsWith(`${sessionWorkspace}/`)
  );
  const managedMetas = metas.filter(isManagedMeta);
  for (const meta of managedMetas) {
    try {
      await worktree.removeWorktree(meta.repoPath, meta.wtDir);
    } catch {
      // Best effort cleanup
    }
  }

  // Clean up session workspace directory (for isolated sessions)
  if (managedMetas.length > 0) {
    try {
      await worktree.removeSessionWorkspace(slug);
    } catch {
      // Best effort cleanup
    }
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
    AGENTDOCK_SERVER: agentdockServerUrl(),
    DISABLE_UPDATE_PROMPT: "true",
    NO_COLOR: "",
    COLORTERM: "truecolor",
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
  };
  const authPassword = getAuthPassword();
  if (authPassword) {
    sessionEnv.AD_AUTH_TOKEN = createHash("sha256").update(`ad:${authPassword}`).digest("hex");
  }

  const systemPromptFile = writeSystemPromptFile(sessionName, Object.keys(meta).length > 0 ? meta : undefined);

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

  await tmux.createSession(sessionName, cwd, sessionEnv, asInitialAgentCommand(cmd));
  await tmux.setOption(sessionName, "extended-keys", "on");

  // Accept Claude startup prompts after the resume command starts.
  await acceptClaudeStartupPrompts(sessionName, skipPerms);
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
