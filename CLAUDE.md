Read @AGENTS.md

# AgentDock — Project Knowledge Base

## What is AgentDock?

A web dashboard for managing parallel AI coding agents (Claude Code, Cursor Agent) across multiple repositories. Agents run in tmux sessions with optional git worktree isolation.

**Stack**: Bun + Hono server (port 4800) | React + Vite client (port 5173) | xterm.js terminal | tmux | No database — all state in `~/.config/agentdock/`

## Build & Dev

```bash
# Both server + client
npm run dev

# Server only (auto-reload)
cd server && bun run --watch src/index.ts

# Client only
cd client && npm run dev

# Build client
cd client && npx vite build
```

## Testing

After making any code changes, always run the test suite:

```bash
cd server && bun test
```

- Run tests before committing or creating PRs
- If you add new functionality, add corresponding tests
- Tests live in `server/src/__tests__/` — use Bun's built-in test runner
- Tests are isolated via `AGENTDOCK_CONFIG_DIR` env var (never touches real config)

## Project Structure

```
server/src/
  index.ts                    # Route mounting, WebSocket setup, startup
  types.ts                    # SessionInfo, CreateSessionRequest, AgentType, etc.
  services/
    config.ts                 # All file-based config CRUD (~/.config/agentdock/)
    session-manager.ts        # Session creation, agent launching, worktree orchestration
    tmux.ts                   # Tmux command interface (create, kill, send-keys, capture)
    status.ts                 # Status detection (hooks primary, terminal fallback)
    worktree.ts               # Git worktree create/delete
    linear.ts                 # Linear ticket fetching
    slack.ts                  # Slack message fetching
  routes/
    sessions.ts               # Session CRUD, switch-agent, sub-agents, meta
    settings.ts               # Health, integrations, preferences, meta-properties
    templates.ts              # Session template CRUD
    git.ts                    # Git diff/branch/PR operations
    ws.ts                     # WebSocket terminal streaming
    auth.ts                   # Auth middleware, login/logout
    quick.ts                  # Quick actions (Slack-to-fix)
    repos.ts, tickets.ts, upload.ts, db.ts
  hooks/
    status-hook.sh            # Claude Code lifecycle hook script
  prompts/
    system-prompt.md          # System prompt template injected into every Claude session

client/src/
  types.ts                    # Mirrors server types (SessionInfo, etc.)
  api.ts                      # All fetch wrappers for API endpoints
  styles.css                  # Global CSS + CSS variable theming (5000+ lines)
  pages/
    Dashboard.tsx             # Main page: session list + terminal/plan/changes split
    CreateSession.tsx         # Session creation form with repo selector, templates, meta
    Login.tsx                 # Auth page
  components/
    Header.tsx                # Top navbar: fix-me, general-chat, quick-launches, settings
    TerminalView.tsx          # xterm.js terminal + WebSocket streaming
    ChangesView.tsx           # Git diff viewer per repo
    SubAgentsView.tsx         # Sub-agent monitoring
    RepoSelector.tsx          # Multi-select repo list with search, recent repos
    SettingsModal.tsx         # Settings UI (repos, MCP, meta-properties, auth, health)
  hooks/
    useSessions.ts            # Polls GET /api/sessions every 3s
    useSettings.ts            # Settings context (theme, font, terminal config)
    usePreferences.ts         # Server-backed preferences context
    useAuth.tsx               # Auth context
```

## Key Architecture Patterns

### File-Based Config (`~/.config/agentdock/`)

No database. Each piece of data is a separate file:

| File | Content |
|------|---------|
| `repos.json` | Repo aliases + paths |
| `preferences.json` | User prefs (theme, pinned, recent repos, quick launches) |
| `meta-properties.json` | Meta property presets |
| `templates.json` | Session templates |
| `session-order.json` | Manual session sort order |
| `sessions/{name}` | Worktree metadata (pipe-delimited `repoPath\|wtDir`) |
| `sessions/{name}.agent` | Agent type: "claude" or "cursor" |
| `sessions/{name}.meta` | Session properties (JSON key-value) |
| `sessions/{name}.type` | Session type label |
| `sessions/{name}.skip-perms` | Flag file (presence = true) |
| `sessions/{name}.parent` | Parent session name (sub-agents) |

### Session Creation Flow

```
CreateSession.tsx → POST /api/sessions → startSession() →
  1. Resolve repo aliases → RepoConfig
  2. Create worktrees if isolated (git worktree add)
  3. launchAgent() → tmux.createSession() + send agent command
  4. Save metadata files (.agent, .meta, .skip-perms, etc.)
  5. Return session names → Dashboard polls and displays
```

### Status Detection (5 Claude Code hooks)

Hooks write to `/tmp/agentdock-status/{sessionName}`:

| Hook | Status | When |
|------|--------|------|
| `PreToolUse` | working | Every tool call (keeps status fresh during sub-agents) |
| `UserPromptSubmit` | working | User sends input |
| `SubagentStop` | working | Sub-agent done, parent still active |
| `Stop` | waiting | Claude finished responding |
| `Notification` | waiting | Idle at prompt |

Terminal pattern matching is **fallback only** for Cursor Agent (no hooks). Never add more terminal scanning for Claude — hooks are the source of truth.

### WebSocket Terminal Streaming

```
Client opens ws://localhost:4800/ws/sessions/{name}
  → Server polls tmux capture-pane every 200-2000ms (adaptive)
  → Sends pane content as JSON
  → Client renders in xterm.js
  → Client keystrokes sent back via send-keys
  → Large paste (>400 chars) uses tmux load-buffer + paste-buffer
```

### Preferences (server-backed, replaces localStorage)

All user preferences stored in `preferences.json` on server — persists across networks:
- `recentRepos`, `pinnedSessions`, `groupBy`, `quickLaunches`
- `theme`, `fontSize`, `cursorBlink`, `scrollback`, `terminalFontSize`

API: `GET /api/settings/preferences`, `PATCH /api/settings/preferences`

### CSS Theming

9 themes via `data-theme` attribute on `<html>`. All colors use CSS variables:
`--bg`, `--bg-card`, `--text`, `--text-dim`, `--accent`, `--border`, `--red`, `--green`, `--cyan`, etc.

## Key Types

```typescript
type SessionStatus = "waiting" | "working" | "background" | "shell" | "unknown";
type AgentType = "claude" | "cursor";

interface SessionInfo {
  name: string;                    // tmux session name (e.g., "claude-repo")
  displayName: string;             // without "claude-" prefix
  status: SessionStatus;
  statusLine?: { type: string; message: string };  // [STATUS: done|input|error | msg]
  agentType?: AgentType;
  meta?: Record<string, string>;   // custom properties
  worktrees: { repoPath: string; wtDir: string }[];
  parentSession?: string;          // sub-agent parent
  children?: string[];             // child session names
  // ... windows, attached, created, path, sessionType
}

interface CreateSessionRequest {
  targets: string[];               // repo aliases, e.g., ["chat", "django:feature-branch"]
  name?: string;
  prompt?: string;
  ticket?: string;                 // Linear ticket ID → auto-creates worktree + prompt
  grouped?: boolean;               // merge targets into one session
  isolated?: boolean;              // create git worktrees
  dangerouslySkipPermissions?: boolean;
  agentType?: AgentType;
  meta?: Record<string, string>;
}
```

## Common Gotchas

- **Session names** are prefixed: `claude-{name}`. The PREFIX constant is in config.ts.
- **tmux send-keys** truncates at ~500 bytes. Large text must use `load-buffer` + `paste-buffer`.
- **Hook status expires** after 2 minutes (no hook fired = stale). Falls back to terminal parsing.
- **Worktree branches** use `wt-{shortId}` for non-ticket sessions to avoid conflicts.
- **Config.ts HOME** is captured at module load time. Tests override via `AGENTDOCK_CONFIG_DIR` env var.
- **Client types.ts and server types.ts** must stay in sync (SessionInfo, CreateSessionRequest, AgentType).
- **styles.css** is 5000+ lines. Search for the class name before adding new styles — it may already exist.
- **Multi-repo sessions without a prompt** get a "wait for task" instruction so Claude doesn't auto-explore.
