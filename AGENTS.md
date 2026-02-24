# AGENTS.md — Adding a New Agent

This document describes how to add support for a new AI coding agent (e.g. Codex, Aider, Copilot CLI) to agentdock. Follow every step — each one is required for full integration.

---

## Overview

The system manages AI coding agents running inside tmux sessions. Each agent type needs:

1. A **type identifier** (e.g. `"codex"`)
2. A **CLI command** to launch it (e.g. `codex`)
3. A **command builder** that constructs the full launch command with flags
4. **Status detection** patterns for its TUI (terminal UI)
5. **Agent switching** support (compress, exit, context transfer)
6. **Health check** to verify the CLI is installed
7. **UI integration** (labels, icons, selectors)

---

## Step-by-step Checklist

### 1. Register the Agent Type

**Files:** `server/src/types.ts`, `client/src/types.ts`

Add your agent to the `AgentType` union in **both** files (they must stay in sync):

```typescript
// Before
export type AgentType = "claude" | "cursor";

// After
export type AgentType = "claude" | "cursor" | "codex";
```

### 2. Build the Agent Command

**File:** `server/src/services/session-manager.ts`

Update `buildAgentCmd()` to handle the new agent. This function returns the shell command string used to launch the agent inside tmux.

```typescript
function buildAgentCmd(agentType: AgentType, dangerouslySkipPermissions?: boolean): string {
  if (agentType === "codex") {
    // Codex uses --full-auto to skip permissions
    return dangerouslySkipPermissions ? "codex --full-auto" : "codex";
  }
  // ... existing claude/cursor cases
}
```

Key considerations:
- What's the CLI command name? (e.g. `codex`, `aider`, `gh copilot`)
- What flag skips permission prompts? (e.g. `--yolo`, `--dangerously-skip-permissions`, `--full-auto`)
- Does it accept an initial prompt as an argument or via stdin?

### 3. Handle Agent Launch Behavior

**File:** `server/src/services/session-manager.ts`

In the `launchAgent()` function, check if the new agent needs special handling during startup:

```typescript
// Does the agent show a trust/welcome prompt that needs dismissing?
if (agentType === "claude") {
  await tmux.sendSpecialKey(sess, "Enter"); // accept trust prompt
}
// Add similar handling for your agent if needed:
// if (agentType === "codex") {
//   await sleep(1000);  // wait for codex to boot
// }
```

Also check how the agent receives an initial prompt:
- Claude: `Read and follow the instructions in <file>`
- Cursor: `Follow the instructions in <file>`
- Your agent: adjust the prompt format in `launchAgent()` if needed

### 4. Add Status Detection Patterns

**File:** `server/src/services/status.ts`

The `detectStatus()` function scans the last few lines of terminal output to determine if the agent is `waiting` (idle at prompt), `working`, or in a `shell`.

Add your agent's TUI patterns:

```typescript
// Working indicators — add patterns for your agent's progress/spinner
if (tail.some((line) =>
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓]/.test(line) ||           // generic spinners
  /^\S\s+\S+…/.test(line) ||                           // Claude cooking animation
  /^(Thinking|Working|Searching|Reading)\.\.\./i.test(line) || // Cursor patterns
  /^codex>/i.test(line)                                 // Your agent's working pattern
)) {
  return "working";
}

// Prompt detection — add your agent's prompt pattern
const isPromptLine = (line: string) =>
  /^❯/.test(line) ||         // Claude prompt
  /^>\s*$/.test(line) ||     // Cursor prompt
  /^codex>\s*$/.test(line);  // Your agent's prompt
```

Tips for discovering patterns:
- Launch the agent manually in a terminal
- Run `tmux capture-pane -p -t <session>` to see raw output
- Check what the prompt looks like when idle vs working

### 5. Add Agent Switching Support

**File:** `server/src/routes/sessions.ts`

The `switch-agent` endpoint handles the full agent switch flow. Update these sections:

#### a. Validation — allow the new type

```typescript
if (!body.agentType || !["claude", "cursor", "codex"].includes(body.agentType)) {
  return c.json({ error: "agentType must be 'claude', 'cursor', or 'codex'" }, 400);
}
```

#### b. Compression command — used to compact context before switching

```typescript
// Each agent has its own command to compress/summarize the conversation
const compressCmd =
  currentAgent === "claude" ? "/compact" :
  currentAgent === "cursor" ? "/summarize" :
  currentAgent === "codex" ? "/compact" :  // check your agent's docs
  "/compact"; // fallback
```

#### c. Exit command — used to cleanly exit the agent

```typescript
// Most agents support /exit, but check your agent's docs
await sendKeysRaw(name, "/exit");
await sendSpecialKey(name, "Enter");
```

If the agent doesn't support `/exit`, you may need Ctrl+C or Ctrl+D fallbacks (already implemented as a fallback).

#### d. Launch command — build the command for the new agent

```typescript
let agentCmd: string;
if (body.agentType === "cursor") {
  agentCmd = skipPerms ? "agent --yolo" : "agent";
} else if (body.agentType === "codex") {
  agentCmd = skipPerms ? "codex --full-auto" : "codex";
} else {
  agentCmd = skipPerms ? "claude --dangerously-skip-permissions" : "claude";
}
```

### 6. Add Health Check

**File:** `server/src/routes/settings.ts`

Add a `checkTool` call for your agent's CLI:

```typescript
app.get("/health", async (c) => {
  const [tmux, claude, cursor, codex, git, gh, bun] = await Promise.all([
    checkTool("tmux", ["-V"]),
    checkTool("claude", ["--version"]),
    checkTool("agent", ["--version"]),
    checkTool("codex", ["--version"]),  // add this
    checkTool("git", ["--version"]),
    checkTool("gh", ["--version"]),
    checkTool("bun", ["--version"]),
  ]);
  return c.json({ tmux, claude, cursor, codex, git, gh, bun });
});
```

**File:** `client/src/api.ts`

Add the field to `SettingsHealth`:

```typescript
export interface SettingsHealth {
  tmux: ToolHealth;
  claude: ToolHealth;
  cursor: ToolHealth;
  codex: ToolHealth;  // add this
  git: ToolHealth;
  gh: ToolHealth;
  bun: ToolHealth;
}
```

**File:** `client/src/components/SettingsModal.tsx`

Add the tool to the health check display:

```typescript
const tools = [
  { name: "tmux", ...health.tmux, required: true },
  { name: "claude", ...health.claude, required: true },
  { name: "cursor (agent CLI)", ...health.cursor, required: false },
  { name: "codex", ...health.codex, required: false },  // add this
  // ...
];
```

### 7. Update UI Components

#### a. Session creation — agent selector

**File:** `client/src/pages/CreateSession.tsx`

Add a radio button option:

```tsx
<label>
  <input type="radio" name="agent" value="codex"
    checked={agentType === "codex"}
    onChange={() => setAgentType("codex")} />
  Codex
</label>
```

#### b. Quick actions modal — agent selector

**File:** `client/src/components/QuickActions.tsx`

Add the option to the agent type selector in the modal.

#### c. Session list — agent badge

**File:** `client/src/pages/Dashboard.tsx`

Update the `SessionRow` component to show an icon for the new agent:

```tsx
{session.agentType === "claude" ? "🤖 Claude" :
 session.agentType === "cursor" ? "💻 Cursor" :
 session.agentType === "codex" ? "🧠 Codex" :
 session.agentType}
```

#### d. Terminal toolbar — switch button

**File:** `client/src/components/TerminalView.tsx`

The switch button currently toggles between Claude and Cursor. If you want to support switching to a third agent, update `handleSwitchAgent` to show a dropdown or cycle through available agents instead of just toggling.

### 8. Configuration Sync (Optional)

**File:** `server/src/services/config-sync.ts`

If your agent reads instructions from `AGENTS.md` (like Cursor) or from its own config file:
- The current sync injects global instructions from `~/.claude/CLAUDE.md` into each repo's `AGENTS.md`
- If your agent reads `AGENTS.md`, it will automatically pick up global instructions
- If your agent uses a different config file, add sync logic in `syncRepoConfig()`

---

## File Reference (All Touchpoints)

| File | What to change |
|---|---|
| `server/src/types.ts` | Add to `AgentType` union |
| `client/src/types.ts` | Add to `AgentType` union (must match server) |
| `server/src/services/session-manager.ts` | `buildAgentCmd()`, `launchAgent()` boot behavior |
| `server/src/services/status.ts` | `detectStatus()` TUI patterns |
| `server/src/routes/sessions.ts` | Switch-agent validation, compress/exit/launch commands |
| `server/src/routes/settings.ts` | Health check `checkTool()` call |
| `client/src/api.ts` | `SettingsHealth` interface |
| `client/src/components/SettingsModal.tsx` | Health check display |
| `client/src/pages/CreateSession.tsx` | Agent type radio button |
| `client/src/components/QuickActions.tsx` | Agent type selector in modal |
| `client/src/pages/Dashboard.tsx` | Agent badge in session list |
| `client/src/components/TerminalView.tsx` | Switch button logic |
| `server/src/services/config-sync.ts` | Config sync (if agent has its own config) |

---

## Agent-Specific Notes

### Claude Code
- CLI: `claude`
- Skip permissions: `--dangerously-skip-permissions`
- Allowed tools: `--allowedTools Read Edit Write Glob Grep 'Bash(git:*)' ...`
- Compress: `/compact`
- Exit: `/exit`
- Trust prompt: Shows on first run, dismissed with Enter
- Config: Reads `~/.claude/CLAUDE.md` (global) and `CLAUDE.md` in repo root

### Cursor Agent
- CLI: `agent`
- Skip permissions: `--yolo`
- Compress: `/summarize`
- Exit: `/exit`
- No trust prompt
- Config: Reads `AGENTS.md` in repo root and `.cursor/rules/` directory

### Adding Codex (Example)
- CLI: `codex`
- Skip permissions: `--full-auto`
- Compress: `/compact` (if supported, otherwise skip)
- Exit: `/exit` or `Ctrl+C`
- Config: Reads `AGENTS.md` and `codex.md` in repo root
