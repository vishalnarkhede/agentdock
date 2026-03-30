# AgentDock — Architecture

This document describes how agentdock works under the hood: the tech stack, key subsystems, data flows, and design decisions.

---

## Stack

| Layer | Tech |
|---|---|
| Server | [Bun](https://bun.sh) + [Hono](https://hono.dev) — port 4800 |
| Client | React + Vite + [xterm.js](https://xtermjs.org) — port 5173 |
| Session management | [tmux](https://github.com/tmux/tmux) |
| Config storage | Plain files in `~/.config/agentdock/` |
| AI agents | Claude Code (`claude` CLI), Cursor Agent (`agent` CLI) |

No database. No containers. No cloud dependencies.

---

## Directory Layout

```
agentdock/
  bin/
    agentdock           # CLI entry point (bash)
    ad-agent            # Sub-agent launcher
  server/               # Bun + Hono API server
    src/
      index.ts          # Route mounting, WebSocket setup, startup
      types.ts          # Shared types (SessionInfo, CreateSessionRequest, AgentType)
      services/
        session-manager.ts    # Session lifecycle (create, launch, stop, restore)
        tmux.ts               # tmux interface (create, kill, send-keys, capture-pane)
        worktree.ts           # git worktree create/delete
        status.ts             # Status detection (hooks + terminal fallback)
        config.ts             # All file-based config CRUD
        linear.ts             # Linear ticket fetching
        slack.ts              # Slack message fetching
      routes/
        sessions.ts           # Session CRUD, agent switching, sub-agents
        settings.ts           # Health, repos, preferences, integrations
        git.ts                # Diff, branch, PR operations
        ws.ts                 # WebSocket terminal streaming
        auth.ts               # Auth middleware, login/logout
        fs.ts                 # File browser, grep
        quick.ts              # Quick actions (Slack-to-fix)
        templates.ts          # Session template CRUD
      hooks/
        status-hook.sh        # Claude Code lifecycle hook script
      prompts/
        system-prompt.md      # System prompt injected into every Claude session
  client/               # React + Vite SPA
    src/
      pages/
        Dashboard.tsx         # Session list + terminal/plan/changes/files split view
        CreateSession.tsx     # Session creation form
        Login.tsx             # Auth page
      components/
        Header.tsx            # Navbar, quick actions, ngrok, settings
        TerminalView.tsx      # xterm.js terminal + WebSocket
        ChangesView.tsx       # Live git diff viewer
        FileExplorer.tsx      # File browser with in-file search
        SettingsModal.tsx     # Settings UI
      hooks/
        useSessions.ts        # Polls GET /api/sessions every 3s
        useSettings.ts        # Theme, font, terminal config
        usePreferences.ts     # Server-backed preferences
        useAuth.tsx           # Auth state
```

---

## Session Lifecycle

### Creation

```
CreateSession.tsx
  → POST /api/sessions
    → startSession()
      1. Resolve repo aliases → absolute paths (config.ts)
      2. If isolated: git worktree add .worktrees/{slug}/{alias} -b wt-{shortId}
      3. launchAgent()
         a. checkAgentInstalled() — throws human-readable error if CLI missing
         b. tmux new-session -d -s {name} -c {workdir}
         c. Write system prompt to /tmp/agentdock-prompt-{name}.md
         d. Write initial task to /tmp/agentdock-task-{name}.md
         e. tmux send-keys: "claude --allowedTools ... < task-file"
         f. Sleep 500ms, send Enter to dismiss trust prompt
      4. Save metadata: .agent, .meta, .skip-perms, .type, .parent
      5. Return { sessionNames: [...] }
```

Session names follow the pattern `claude-{alias}` (or `cursor-{alias}`). The `PREFIX` constant (`"claude-"`) is defined in `config.ts`.

### Worktree Isolation

When `isolated: true`, each repo gets its own git worktree at:

```
{basePath}/.worktrees/{sessionSlug}/{repoAlias}/
```

The worktree branch is `wt-{8-char-hash}` for regular sessions, or the Linear ticket ID branch for ticket-based sessions (e.g. `MOD-267`). On session stop, worktrees are deleted automatically.

### Agent Launch Command

```typescript
// Claude Code (default)
claude --allowedTools Read Edit Write Glob Grep Bash(git:*) Bash(gh:*) ...
       --permission-prompt-tool-name mcp_agentdock_permission_prompt
       --dangerously-skip-permissions  // if skip-perms flag set
       --resume <uuid>                 // if restoring a stopped session

// Cursor Agent
agent --yolo  // if skip-perms flag set
```

The full allowed tools list covers: `Read`, `Edit`, `Write`, `Glob`, `Grep`, common `Bash(cmd:*)` patterns (git, gh, grep, cat, ls, find, go, make, npm, bun, python, node, curl), plus `mcp__*` and `WebFetch`.

### Restore

When a session is stopped (e.g. after a reboot), its Claude conversation history lives in `~/.claude/projects/{path-hash}/`. On restore:

1. Scan that directory for `.jsonl` conversation files
2. Pick the most recently modified one
3. Extract the UUID from the filename
4. Launch: `claude --resume {uuid} ...`

This bypasses Claude's interactive session picker entirely.

---

## Status Detection

Agent status (`waiting` / `working` / `background` / `shell` / `unknown`) is the core UX signal — it drives the colored dot on each session row.

### Primary: Claude Code Hooks

Five hooks write to `/tmp/agentdock-status/{sessionName}`:

| Hook | Status written | Fires when |
|---|---|---|
| `PreToolUse` | `working` | Every tool call — fires constantly during active work |
| `UserPromptSubmit` | `working` | User sends input |
| `SubagentStop` | `working` | Sub-agent finishes, parent still running |
| `Stop` | `waiting` | Claude finishes a response turn |
| `Notification` | `waiting` | Claude is idle at the prompt |

The hook script (`server/src/hooks/status-hook.sh`) writes a JSON file:

```json
{ "status": "working", "ts": 1712345678 }
```

The server reads this file on every `/api/sessions` poll. Status expires after 2 minutes of silence (falls back to terminal parsing).

Claude Code hooks are configured in `~/.claude/settings.json` and injected via the system prompt's `CLAUDE.md` template. The hook is called with `bash status-hook.sh working` or `bash status-hook.sh waiting`.

### Fallback: Terminal Pattern Matching

For Cursor Agent (no hook support) or before hooks report, `detectStatus()` in `status.ts` scans the last few lines of `tmux capture-pane` output:

- **Shell** — last command is `bash`, `zsh`, etc. → `shell`
- **Working** — spinner characters (`⠋⠙⠹`), cooking animation, "Thinking...", Cursor's progress lines → `working`
- **Waiting** — Claude prompt (`❯`), Cursor prompt (`>`) with no input → `waiting`

### Status Line

Agents can also emit a structured status line anywhere in their terminal output:

```
[STATUS: done | implemented OAuth login]
[STATUS: input | which database should I use?]
[STATUS: error | build failed: missing dependency]
```

`extractStatusLine()` in `status.ts` scans terminal content for this pattern and surfaces it in the UI below the session name.

---

## WebSocket Terminal Streaming

```
Client                          Server
  |                               |
  |── WS connect /ws/{name} ────→ |
  |← { type: "snapshot", data } ──|  (initial pane content)
  |                               |
  |                    poll loop (adaptive 200ms–2000ms):
  |                      tmux capture-pane → compare with last
  |← { type: "update", data } ────|  (only on change)
  |                               |
  |── { type: "key", data: "ls" } →|
  |                      tmux send-keys "ls"
  |── { type: "paste", data: "..." }→|  (>400 chars)
  |                      tmux load-buffer | paste-buffer
  |── { type: "resize", cols, rows }→|
  |                      tmux resize-pane
  |── { type: "ping" } ──────────→|  (client heartbeat every 30s)
```

**Adaptive polling**: on content change, poll at 200ms. On no change, back off by 1.5× up to 2000ms. Immediately after user keystrokes, poll at 50ms for snappier feedback. If no message from client in 60s, the connection is considered dead.

**Large pastes**: tmux `send-keys` truncates at ~500 bytes. Text >400 chars is sent via `tmux load-buffer -` piped to `tmux paste-buffer`.

The xterm.js terminal on the client renders the `tmux capture-pane` snapshot, which includes all visible text and ANSI escape codes (colors, cursor position).

---

## File-Based Configuration

All state lives in `~/.config/agentdock/` — no database required.

| File | Contents |
|---|---|
| `base-path` | Single line: absolute path to repos root |
| `repos.json` | `[{ alias, folder, remote }]` |
| `preferences.json` | Theme, font, pinned sessions, recent repos, MRU list, quick launches |
| `templates.json` | Session prompt templates |
| `meta-properties.json` | Preset key-value meta properties |
| `session-order.json` | Manual session sort order |
| `sessions/{name}` | Worktree metadata: `repoPath\|wtDir` (pipe-delimited) |
| `sessions/{name}.agent` | Agent type: `claude` or `cursor` |
| `sessions/{name}.meta` | Custom properties (JSON) |
| `sessions/{name}.type` | Session type label |
| `sessions/{name}.skip-perms` | Presence = dangerously skip permissions |
| `sessions/{name}.parent` | Parent session name (for sub-agents) |
| `auth-password` | Bcrypt hash of the dashboard password |
| `plans/{sessionName}.md` | Structured plan written by the agent |
| `mcp-servers.json` | MCP server definitions, synced to Claude config |

Config operations are all synchronous file I/O — intentionally simple, no locking needed for typical usage.

---

## System Prompt & Agent Instructions

Every Claude session gets a system prompt injected via a file at `/tmp/agentdock-prompt-{name}.md`. The prompt template lives in `server/src/prompts/system-prompt.md` and has two template variables replaced at runtime:

- `{{PLANS_DIR}}` → `~/.config/agentdock/plans/`
- `{{SESSION_NAME}}` → the tmux session name

The prompt instructs Claude to:
- Write structured plans to `{{PLANS_DIR}}/{{SESSION_NAME}}.md`
- Emit `[STATUS: done|input|error | message]` lines so the UI can surface progress
- Follow the hooks-based status reporting convention

---

## MCP Server Sync

MCP servers configured in **Settings → MCP Servers** are stored in `mcp-servers.json` and automatically written to `~/.claude/claude_desktop_config.json` so they're available in every Claude session. The sync runs on server startup and whenever MCP config changes.

---

## Authentication

Authentication is optional. When enabled:

1. `~/.config/agentdock/auth-password` contains a bcrypt hash
2. On login, the password is verified against the hash
3. A signed JWT-like token is issued and stored as an HTTP-only cookie
4. `auth.ts` middleware validates the token on every API request
5. The WebSocket upgrade also validates the token

When no `auth-password` file exists, auth is disabled and all requests are allowed.

---

## Git Worktrees

Worktree isolation allows multiple sessions to work on the same repo simultaneously without conflicts:

```
~/projects/
  my-repo/              ← main working tree (untouched)
  .worktrees/
    abc123/
      my-repo/          ← worktree for session "abc123"
                           on branch wt-a1b2c3d4
```

Each worktree is a full checkout with its own index and working tree, but shares the git object store with the main repo. Claude Code operates entirely within the worktree directory — it can't see or affect the main working tree.

On session stop, `removeSessionWorkspace()` deletes the `.worktrees/{slug}/` directory and runs `git worktree prune` on the source repo to clean up stale references.

---

## Sub-Agents

A session can spawn sub-agents to parallelize work across repos. Sub-agents are child tmux sessions with a `parent` pointer stored in `sessions/{name}.parent`.

The parent session orchestrates via `tmux send-keys` to each child. The `SubagentStop` hook fires when a child finishes, keeping the parent's status as `working` until all children complete.

Sub-agents are shown in a collapsed tree under the parent session in the UI.

---

## Design Decisions

**Why tmux?**
Process management, session persistence, and terminal capture without reinventing process supervision. `tmux capture-pane` gives us the rendered terminal content including all ANSI sequences, which xterm.js renders faithfully.

**Why Bun?**
Fast startup (<100ms), built-in TypeScript support, native WebSocket handling, and a built-in test runner. No transpile step needed for the server.

**Why no database?**
Session state is ephemeral (tmux sessions don't survive reboots anyway). Configuration is a handful of small JSON/text files. A database would add ops complexity with no benefit at this scale.

**Why file-based hooks for status?**
Polling terminal output for status is fragile — output format varies by agent version, locale, and terminal size. Claude Code's lifecycle hooks are deterministic: they fire exactly when Claude starts and stops work. The hook writes a timestamped JSON file; the server reads it. No IPC, no shared memory, no sockets.

**Why xterm.js instead of a custom renderer?**
Full ANSI/VT100 support, correct cursor handling, selection, scrollback, and font rendering out of the box. Claude Code and Cursor Agent both use rich terminal UIs that depend on escape sequences — a plain `<pre>` renderer would lose all the color and formatting.
