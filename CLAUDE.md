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
    lsp.ts                    # Language server pool (definitions, references, hover)
    symbol-index.ts           # Regex symbol index — the fallback when no server serves a file
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
    code.ts                   # Code intelligence: definition, references, hover, symbols
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

### Files Search

Search uses the bundled `@vscode/ripgrep` binary rather than assuming `rg` is
on a Finder/launchd PATH. Native search is staged: filename matches come from
the in-memory path index after a 70ms debounce, then content matches replace the
content section when ripgrep finishes. Multiple session roots run concurrently,
each ripgrep is capped at four threads and 200 results, and cancellation kills
the child process.

The path index is kept current with a recursive FSEvents watcher on macOS. Its
cache and watchers are capped at six roots; platforms without recursive watch
retain the short TTL fallback. Do not return to rebuilding the path index on
every query or combine filename and content search into one blocking client
request.

### Code Intelligence (language servers, with the regex index as fallback)

Cmd-click in Files asks a language server, not a regular expression. `lsp.ts`
keeps one warm process per (server, project root) — gopls, tsserver, pyright,
sourcekit-lsp — started on first use and reaped after five idle minutes. The pool
is capped at two; only one Go workspace may stay warm, with a RAM-scaled
`GOMEMLIMIT` capped at 1 GiB, while Node language servers get 512 MiB heaps. Every entry point
returns `null` rather than throwing, so a missing server, a cold index or a crash
falls back to `symbol-index.ts` and the response says which layer answered in
`source`. Interactive definitions wait 350ms, then return `source: "warming"`
while the exact request continues in the background, so the UI never waits on a
monorepo or guesses the wrong overload or field.

Position-based lookups are **POST** because they carry the unsaved buffer;
without it a lookup resolves against the file on disk and lands on the wrong
line. Positions are 1-based in both axes everywhere in AgentDock and converted
at the LSP boundary. The regex index is a startup/unsupported-language fallback,
not a substitute for semantic navigation.

Full detail, including the two tsserver quirks that need workarounds, is in
[docs/code-intelligence.md](docs/code-intelligence.md).

### WebSocket Terminal Streaming

```
Client opens ws://localhost:4800/ws/sessions/{name}
  → Server attaches tmux through Bun.Terminal (native PTY)
  → Raw terminal bytes stream as binary WebSocket frames
  → Client writes bytes directly to xterm.js
  → Input and resize messages go directly to the PTY
  → Wheel and swipe become { type: "scroll", lines } → tmux copy mode
  → tmux remains the persistent session owner after disconnect
```

tmux mouse mode stays **off** for these sessions so drag-select belongs to the
browser. With it on, xterm forwards the drag to tmux, which highlights, copies
into a tmux buffer on release and cancels — the selection disappears and the
text never reaches the reader's clipboard. Scrolling does not need it: the
history is requested by name instead.

The attached browser's grid is pinned as the tmux window size (`resize-window`
on attach and on every real resize). `window-size` stays `manual` after
detach — unsetting it made the next iTerm or `tmux attach` SIGWINCH the agent
and replay the transcript. Other viewers letterbox or see blank padding
(`fill-character` is a space) rather than resizing the window. Detaching also
stores the browser's grid as `default-size` so a dropped pin does not snap
back to the 80×24 the session was created at.

**Never resize a window with a browser attached to it if it can be done first.**
A resize signals the agent, and an agent TUI answers by rewriting its whole
transcript — 3.1MB over three seconds on a measured Cursor session — which is
exactly what "opens at the top and scrolls to the bottom" was. `settlePtyWindow()`
in `tmux-pty.ts` resizes before the PTY is spawned and polls `capture-pane` until
the pane stops changing (1.2s cap), so the redraw happens with nobody watching.
It costs one tmux call when the size already matches.

Two more pieces keep an open clean:

- `ws.ts` batches PTY output for 8ms (or 64KB) before sending. One Cursor redraw
  arrived as 81,000 twelve-byte frames unbatched, and xterm rendered it fragment
  by fragment for over a second; batched it is a few dozen frames and one
  repaint. Input is never delayed.
- `TerminalView` holds the rows at `opacity: 0` and samples its own visible rows
  every 80ms, fading them in once two samples differ by no more than a tenth of
  the rows (capped 1.6s after the first byte). Do not go back to timing the byte
  stream: redraws arrive in bursts with gaps that look like calm, and a TUI that
  repaints an unchanged screen never goes quiet at all.

Resizes that do not change the grid are dropped in `tmux-pty.ts`: a window set to
the size it already has repaints too, and the client reports the same grid
several times per attach.

### Preferences (server-backed, replaces localStorage)

All user preferences stored in `preferences.json` on server — persists across networks:
- `recentRepos`, `pinnedSessions`, `groupBy`, `quickLaunches`
- `theme`, `fontSize`, `cursorBlink`, `scrollback`, `terminalFontSize`

API: `GET /api/settings/preferences`, `PATCH /api/settings/preferences`

### CSS Theming

9 themes via `data-theme` attribute on `<html>`. All colors use CSS variables:
`--bg`, `--bg-card`, `--text`, `--text-dim`, `--accent`, `--border`, `--red`, `--green`, `--cyan`, etc.

**Important**: Several themes (especially glass) use semi-transparent rgba values for `--bg-card`, `--bg-input`, and `--border`. See the **UI & CSS Guidelines** section before using these variables.

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

## UI & CSS Guidelines

### Before touching any CSS or component

1. **Search styles.css first** — it's 5000+ lines. The class you need likely already exists. `grep` before adding.
2. **Read the full component + its CSS section** before making any change. Understand what's already there.
3. **Check CSS variable resolution** before using a variable as a background, especially on the glass theme:

| Variable | Glass theme value | Safe for floating elements? |
|----------|------------------|----------------------------|
| `--bg` | `#0f0f1a` (solid) | ✅ yes |
| `--bg-modal` | `#1a1a2e` (solid) | ✅ yes |
| `--bg-card` | `rgba(255,255,255,0.05)` — **5% opacity** | ❌ NO |
| `--bg-input` | `rgba(255,255,255,0.07)` — **7% opacity** | ❌ NO |
| `--bg-hover` | `rgba(255,255,255,0.10)` | ❌ NO |
| `--border` | `rgba(255,255,255,0.08)` | ❌ NO |

**Rule**: Any element that floats above other content (modal, dropdown, tooltip, context menu, popover) must use a solid background. Use `var(--bg-modal, var(--bg-input))` — never `var(--bg-card)` alone.

### Floating elements (modals, dropdowns, menus)

- Always use `var(--bg-modal, var(--bg-input))` as the background — not `--bg-card`
- If a dropdown is clipped by a parent with `overflow: hidden` or `overflow: auto`, it needs `createPortal(el, document.body)` + `position: fixed` + `getBoundingClientRect()` to position
- Never rely on `z-index` alone to fix transparency — a transparent background shows through regardless of stacking order

### Layout side effects to check before changing

- **`body` padding-bottom on mobile** — must stay at `52px` (the fixed bottom nav height). Removing it hides the terminal toolbar behind the nav bar.
- **`overflow: hidden/auto` on parents** — clips `position: absolute` children. Check parent chain before using absolute positioning for dropdowns.
- **Fixed bottom nav** — any full-height content needs `padding-bottom: 52px` on mobile.
- **`body.mobile-kb-open`** — when keyboard is open, header and nav are hidden, body padding is 0. Don't assume nav/header are visible when in terminal.

### Mobile UX

- **Tap targets**: minimum 44×44px. Use padding to achieve this without enlarging the visual element.
- **Safe area insets**: use `env(safe-area-inset-bottom)` only inside elements that sit at the physical bottom edge of the screen (e.g., the nav bar itself). Do NOT apply it to `body` padding — it causes double-counting.
- **Keyboard visibility**: handled via `body.mobile-kb-open` class. Terminal fills screen when keyboard is open.

### Redesign requests

When asked to redesign a component or "fix UX":
1. **Understand the problem first** — what exactly is broken? Read the component, see what CSS applies.
2. **Plan the layout** — what elements exist, how should they be arranged, what are the constraints (mobile vs desktop, fixed heights, overflow)?
3. **Design holistically** — don't patch one line. Consider the full component layout before touching code.
4. **Don't create new patterns** — reuse existing CSS classes and variables. Check if a similar component already exists.

### Existing patterns to reuse

- `settings-overlay` + `settings-modal` — standard modal shell (already correct background)
- `createPortal` + `getBoundingClientRect` — pattern for dropdowns that must escape overflow containers (see `MetaSelect` in Dashboard.tsx)
- `var(--bg-modal, var(--bg-card))` — safe popup background across all themes

---

## Common Gotchas

- **Session names** are prefixed: `claude-{name}`. The PREFIX constant is in config.ts.
- **tmux send-keys** truncates at ~500 bytes. Large text must use `load-buffer` + `paste-buffer`.
- **Hook status expires** after 2 minutes (no hook fired = stale). Falls back to terminal parsing.
- **Worktree branches** use `wt-{shortId}` for non-ticket sessions to avoid conflicts.
- **Config.ts HOME** is captured at module load time. Tests override via `AGENTDOCK_CONFIG_DIR` env var.
- **Client types.ts and server types.ts** must stay in sync (SessionInfo, CreateSessionRequest, AgentType).
- **styles.css** is 5000+ lines. Search for the class name before adding new styles — it may already exist.
- **Multi-repo sessions without a prompt** get a "wait for task" instruction so Claude doesn't auto-explore.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **agentdock** (4470 symbols, 9186 relationships, 228 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact analysis before editing.** Use `impact({target: "symbolName", direction: "upstream"})` (MCP) or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .` (CLI fallback); report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/agentdock/context` | Codebase overview, check index freshness |
| `gitnexus://repo/agentdock/clusters` | All functional areas |
| `gitnexus://repo/agentdock/processes` | All execution flows |
| `gitnexus://repo/agentdock/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
