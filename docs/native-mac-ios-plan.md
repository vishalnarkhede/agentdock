# AgentDock native apps — Mac host + iOS companion

This is the product and engineering plan for a native AgentDock. Write it here so later sessions do not have to reconstruct the decision from chat.

**Status:** M0 and the M1 shell are implemented and running (`macos/`). Mac is the first implementation track. iOS is specified now so Mac work does not block pairing, sizing, or transport later. See §5.0 for exactly what exists today.

**Not this project:** a React Native “universal” app (one JS UI on Mac and iPhone). RN is a poor host for a GPU terminal; Apple platforms get Swift + libghostty.

---

## 1. Product

### What we are building

Two apps that share a host, not two independent AgentDocks.

| | macOS app | iOS companion |
|---|---|---|
| Role | Host | Remote viewer |
| Runs `claude` / `agent` / git / worktrees | Yes | No |
| Owns session state | Yes (`~/.config/agentdock/` + tmux) | No |
| Terminal renderer | libghostty | libghostty |
| If this device sleeps | Sessions keep running in tmux on Mac | Connection drops; Mac is unchanged |
| v1 ship | Primary daily driver on this machine | After Mac feels native |

The phone never launches agents. There is no CLI, no worktree, and no tmux on iOS. That is the same split cmux uses.

The existing **web SPA stays**. It remains the Linux/Windows path and a fallback when the native app is not installed. Native is an extra viewer, then the default on this Mac.

### Why native at all

cmux feels native because the terminal **surface persists in-process**: PTY, parser, scrollback, cursor, and Metal renderer belong to one engine. Switching workspaces shows an existing view.

AgentDock today does the opposite when you click a session:

1. `TerminalView` is keyed by `activeSession` (`Dashboard.tsx`).
2. React unmounts; xterm disposes; WebSocket closes; tmux client detaches.
3. A new xterm mounts, measures a grid, opens `/ws/sessions/:name`.
4. Server `settlePtyWindow` + `attachPty` (`tmux attach-session` via `Bun.Terminal`).
5. tmux paints the screen (often more than once). Agent TUIs may rewrite megabytes on resize.

We paper over that with settle-before-attach, 8ms output batching, and an opacity veil. A native app is only worth it if we **stop destroying the surface**, not if we wrap the SPA in a native window.

### Locked decisions

1. Mac + iOS companion. Not universal RN. Android stays on the web client for now.
2. Keep the Bun + Hono server. It owns sessions, hooks, config, git, files, auth. Native hosts it; it does not reimplement it.
3. libghostty for every terminal that is supposed to feel native (Mac v1, iOS v1).
4. **Files, Plan, and Changes are native Swift**, not WKWebView wrappers of the React UI. They call the same REST (`/api/fs`, `/api/git`, `/api/plan`, `/api/code`). The rest of the Mac chrome (session rails, create, settings, worktrees) is native Swift as well; WebView is not the product. See §2.
5. Native panes are **siblings** of Ghostty (split view). Never portal Ghostty through a web view.
6. Web SPA remains until the Mac app is the daily driver here.
7. Implementation order: **Mac first**, iOS second. Mac APIs must still be iOS-safe (see §7).

---

## 2. Feature catalog (nothing omitted)

AgentDock is not “a terminal plus a few tabs.” The Mac app is a **native Swift app**: every product surface is SwiftUI (or AppKit where needed), talking to the existing Bun APIs. The React SPA remains for Linux/Windows/Safari only.

Legend: **N** = Swift on Mac (this project) · **S** = Swift, later Mac milestone · **i1** = iOS v1 · **iL** = iOS later · **—** = not on that client

**Session rails (native, Mac track after Ghostty):** Files, Plan, Changes, Sub-agents, Worktrees. These are first-class panes, same as the terminal — not an embedded website.

### 2.1 How you get to work

| Feature | What it is today | Mac v1 | iOS |
|---|---|---|---|
| Session list | Dashboard sidebar: status, pin, MRU, group-by, meta filters, rename, delete, restore stale | **N** | **i1** list + status |
| Queue / Next | Header chips, `N` walks blocked sessions (`queue.ts`) | **N** | **i1** (next blocked) |
| Per-session surface memory | Last tab (files/changes/plan) remembered per session | **N** | iL |
| Login / password | `Login.tsx`, `ad_session` cookie | **N** URLSession + keychain | pairing token, not password |
| Demo mode | `demo.ts` fake sessions | skip | skip |

### 2.2 Starting sessions

| Feature | What it is today | Mac v1 | iOS |
|---|---|---|---|
| Create session | `CreateSession.tsx`: repos, isolated worktrees, new branch, agent type, skip-perms, name, prompt | **N** (after rails) | — (create on Mac) |
| Task sources | Linear ticket id, Slack thread, blank prompt, “just talk” | **N** | — |
| Templates | Save/load session templates | **N** | — |
| Meta properties | Presets (priority, customer, …) on create and on rows | **N** | iL badges |
| Repo selector | Multi-repo, search, recents, primary repo | **N** | — |
| Fix me | Header: session on current machine context | **N** → `POST /api/sessions` | — |
| General chat | Header: `targets: []`, skip-perms | **N** | — |
| Quick launches | Saved target sets in preferences | **N** | — |
| File drop on create | Upload → path in prompt | **N** | — |

### 2.3 Session chrome (dashboard rail)

These are first-class **native panes** beside Ghostty (`Dashboard.tsx` `RAIL` + worktrees + shells). Switching Files ⟷ Terminal must **not** dispose Ghostty.

| Feature | What it is today | Mac | iOS |
|---|---|---|---|
| **Terminal** | xterm + PTY WS, toolbar, drop-to-upload | **N** Ghostty | **i1** Ghostty + keys/Esc/paste |
| Extra **shells** | Up to 2 plain tmux shells beside the agent | **N** extra Ghostty surfaces | — |
| **Plan** | `PlanView`: plan.md, outline, comments, send-to-agent | **N** Swift (same `/api/plan`) | iL read-only (share Mac models) |
| **Changes** | `ChangesView`: git status/diff, line comments → agent, push, PR | **N** Swift (same `/api/git`) | iL read-only |
| **Files** | `FileExplorer`: tree, grep, editor, md preview, in-file search, ⌘[/], external path, note-to-agent, save | **N** Swift (same `/api/fs` + `/api/code`). Editor is native (TextKit / Runestone / similar) — not CodeMirror in a web view | iL optional; v1 too dense |
| **Sub-agents** | `SubAgentsView`: children, status, jump, delete | **N** | iL |
| **Worktrees** | `WorktreesView`: list, dirty, batch delete | **N** (global, not per-session) | — |
| Open in iTerm | `POST .../open-iterm` | **N** | — |
| Switch agent | Claude ⟷ Cursor | **N** | — |
| Rename / meta edit | Session `.meta`, display name | **N** | — |
| Stop / delete session | DELETE session | **N** | iL (Mac first) |

### 2.4 Empty / idle dashboard

| Feature | What it is today | Mac v1 | iOS |
|---|---|---|---|
| Quiet view | `QuietView` when no live session: restore stale, housekeeping facts | **N** | — |
| Housekeeping | `GET /api/housekeeping` (read-only) | **N** | — |
| Restore session | `POST /api/sessions/:name/restore` | **N** | — |
| Tutorial | `TutorialOverlay` | skip | — |
| Bind mode | Localhost vs LAN (password required) | **N** | i1 needs LAN bind |

### 2.5 Settings (`SettingsModal` categories — all of them)

| Pane | Contents today | Mac v1 | iOS |
|---|---|---|---|
| Repositories | aliases, paths, add/remove | **N** | — |
| Agents | Claude/Cursor CLI flags, skip-perms default, hook install | **N** | — |
| Notifications | enable, test, click-opens-session | **N** + `UNUserNotificationCenter` | i1 in-app; APNs iL |
| Worktrees | base path, post-create hook, cleanup | **N** | — |
| Session properties | meta-property presets CRUD | **N** | — |
| Access / security | password, pairing QR, ngrok basic auth | **N** | **i1** consume QR |
| Appearance | app chrome theme; Ghostty font/theme | **N** | Ghostty theme |
| Terminal | Ghostty font, cursor, scrollback | **N** | — |
| Health | tmux, claude, agent, git, gh, bun | **N** | — |
| Shortcuts | native menus + settings list | **N** | — |

MCP: create flow **reads** agent MCP config (Linear, etc.); AgentDock does not host MCP. Native create shows the same facts. No iOS.

### 2.6 Header / network

| Feature | What it is today | Mac v1 | iOS |
|---|---|---|---|
| Phone link | `PhoneLink.tsx` + `GET /api/network` | **N** pairing QR (same addresses) | scanner |
| ngrok | start/stop, public URL, copy | **N** | open Mac URL if tunneled iL |
| Logout | auth | **N** | unpair |

### 2.7 APIs the native panes call (do not drop)

Swift UI, same JSON. Not a second git implementation on the client: the Mac app is a client of Bun.

| Area | Routes | Native pane |
|---|---|---|
| Git | `/api/git` | Changes |
| Review | `/api/review` | Quiet / plan / review bucket |
| Plan comments | `/api/plan` | Plan |
| Code nav | `/api/code` | Files |
| FS | `/api/fs` | Files |
| Upload | `/api/upload` | Files + terminal drop |
| Repos | `/api/repos` | Create + settings |
| Templates | `/api/templates` | Create |
| DB shards | `/api/db` | Settings if we keep that UI |

### 2.8 Agent runtime (server, not a panel)

Must keep working with zero Swift rewrite:

- Claude Code + Cursor Agent launch (`session-manager`, `buildAgentCmd`)
- Lifecycle hooks → `/tmp/agentdock-status/` → session status
- System prompt injection, prompt files
- Worktree create on isolated sessions (`worktree.ts`)
- Sub-agent parent/child files
- `ad-agent` launcher, `AGENTDOCK_SERVER`, `AD_AUTH_TOKEN`
- Switch-agent compact/exit/relaunch
- Status fallback scan for Cursor

### 2.9 Web/mobile SPA (keep until native iOS)

Today’s phone is Safari: bottom nav (terminal / plan / changes / files), `CustomKeyboard`, `MobileQueue`, `MobileApprove`, swipe-back. That remains the **fallback** if the iOS app is not installed. iOS v1 replaces terminal+queue; it does **not** need to clone Files/Changes on day one because those stay on Mac (and in Safari).

### 2.10 Mac “complete product” gate

The Mac app is not done when Ghostty works. It is done when a week of real use does not send you back to Chrome for:

session list, create (ticket/slack/templates/isolated), terminal, extra shells, **native plan, changes, files**, sub-agents, worktrees, settings, fix-me / general chat / quick launches, quiet/housekeeping/restore, pairing QR, ngrok, notifications, iTerm, switch agent.

**Build order on Mac (still before iOS):** Ghostty + session list → **Files + Plan + Changes** → worktrees/sub-agents/quiet → create + settings. Do not ship a “terminal-only” AgentDock as the product.

---

## 3. Current system (constraints the native app inherits)

Stack today:

- Server: Bun + Hono, port **4800** (`server/src/index.ts`).
- Client: React + Vite, port **5173**, xterm.js + WebGL addon.
- Sessions: tmux, names prefixed (see `PREFIX` in `server/src/services/config.ts`).
- Config: files under `~/.config/agentdock/` (no database).
- Auth: cookie `ad_session`; WebSocket uses `verifyWsCookie`. Agents get `AD_AUTH_TOKEN` (SHA-256 of `ad:` + password) in the tmux environment (`launchAgent` in `session-manager.ts`).
- Create flow: `POST /api/sessions` → `startSession()` → worktrees if isolated → `tmux.createSession` → send agent CLI → metadata files.
- Terminal: browser → `ws://…/ws/sessions/{name}?cols&rows` → `settlePtyWindow` → `attachPty` → binary PTY frames; JSON for `input` / `resize` / `scroll` / `ping`.
- Phone today: Safari to LAN URL from `GET /api/network` + QR (`PhoneLink.tsx`). Same xterm stack, smaller viewport.
- iTerm: `POST /api/sessions/:name/open-iterm` attaches another tmux client.

tmux remains the **persistence** layer: kill the GUI, agents keep running. That must stay true for the Mac app (quit the window ≠ kill sessions).

Painful tmux facts the native app must not ignore:

- One window size per pane. A second client (iTerm, phone, old web tab) fights the first.
- `resize-window` signals the agent; Cursor has been measured rewriting ~3.1MB over seconds.
- Attach paints the screen (capability probes → extra redraws).
- Alternate screen: browser scrollback is empty; we send `{ type: "scroll" }` into tmux copy-mode.
- `mouse off` so selection is not stolen by tmux.

---

## 4. Target architecture

```
                    ┌──────────── iOS app (later) ────────────┐
                    │ SwiftUI session list                     │
                    │ Ghostty UIView (one visible surface)     │
                    │ Pairing token + LAN / later Tailscale    │
                    └───────────────┬──────────────────────────┘
                                    │ HTTPS + WSS (or later replay)
┌─────────────────── macOS app ─────┴─────────────────────────┐
│ SwiftUI: session sidebar, chrome, notifications               │
│ TerminalSurfaceStore: one Ghostty surface per live session    │
│   show/hide NSView — never dispose on switch                  │
│ SwiftUI: files, plan, changes, worktrees, settings, create    │
│ AppDelegate: spawn/supervise bun server, tray, URL schemes    │
│                                                               │
│   localhost:4800  Bun/Hono  (existing routes)                 │
│   tmux sessions   agents, hooks, ~/.config/agentdock          │
└───────────────────────────────────────────────────────────────┘

Still available: browser SPA on :5173 talking to the same :4800
```

### 4.1 Who owns the PTY (two stages)

**Mac v1 (ship this first):** Ghostty is a long-lived **tmux client**, same as today’s Bun PTY, but the client is not torn down when you click another session. Switching is show/hide. iTerm and web can still attach; sizing fights remain until v2.

**Mac v2 (required before iOS feels good, useful on Mac even alone):** the Mac app’s Ghostty surface is the **primary viewer**. Options, pick when we get there:

- **A (preferred):** session-manager still creates tmux for persistence and iTerm, but the Mac app attaches **once** at launch of that session and keeps the attach for the life of the tmux session (including when the Ghostty view is hidden). Phone/web are secondary: they must not `resize-window` while Mac is focused; they letterbox or follow Mac size.
- **B (harder, closest to cmux local):** Ghostty owns the PTY; tmux is only for restore/iTerm via control mode (`tmux -CC`) feeding `%output` into Ghostty. Do not start here. Control-mode in this repo was removed because snapshot sync was wrong; the protocol itself is not forbidden.

v1 must not bake in “every viewer attach()s and pins size.” Surface APIs should take a **size authority** flag (Mac focused vs companion).

### 4.2 TerminalSurfaceStore (Mac — the whole point)

In-process store, not React:

```
session name → {
  ghostty_surface,
  attached tmux client (v1) or PTY (v2),
  last grid cols×rows,
  viewport / selection (engine-owned),
  realized GPU: yes | reclaimed
}
```

Rules:

- Creating a session in AgentDock creates or binds a surface.
- Switching sessions never calls dispose on the previous surface.
- Hidden surfaces stay connected and keep parsing; GPU may be released after idle (cmux does this; v1 can keep all GPUs warm if session count is small, e.g. ≤ 15).
- Closing a session in the UI kills tmux (existing DELETE) and then destroys the surface.
- Quitting the Mac app detaches viewers but **does not** kill tmux (same as closing a browser tab today).

### 4.3 Desktop chrome vs web panels

### 4.3 Desktop chrome (all native)

Split view: sidebar | Ghostty | optional **native** pane (Files / Plan / Changes / …). Ghostty stays mounted when the pane changes.

SwiftUI (Mac order):

1. Session list, queue, terminal/shells (Ghostty)
2. **Files, Plan, Changes** — full native implementations of today’s React features, same REST
3. Sub-agents, worktrees, quiet/housekeeping
4. Create session, settings (all categories), pairing QR, ngrok

**Files (native):** see §4.3.1 — we do **not** write a text editor from scratch, and we do **not** embed a whole third-party IDE explorer. Editor view = open-source Mac library; tree, search UI, and navigation = our Swift, talking to existing `/api/fs` + `/api/code` + search (ripgrep on the server).

**Plan (native):** parsed plan blocks, outline, comments, send-to-agent — port `plan-blocks.ts` logic to Swift or keep parsing on the server.

**Changes (native):** file list, hunks, line selection, comments to agent, push, PR — `/api/git`.

No WKWebView product UI. Vite is unused by the Mac app (SPA is a separate client).

### 4.3.1 Files explorer — library vs ours

Today’s explorer is fast because **search is not in the UI**. Filename hits come from an in-memory index in tens of milliseconds; content hits spawn **ripgrep** on the server (`content-search.ts`). In-file search, ⌘[/], and go-to-definition are small client modules (`text-matches.ts`, `nav-history.ts`, `/api/code`). A native port must keep that split. Reimplementing ripgrep or a fuzzy index in Swift would be slower and worse.

| Layer | Approach | Why |
|---|---|---|
| Text editor (highlight, wrap, line numbers, **in-file find**, jump to line/match, large files) | **Library:** [CodeEditSourceEditor](https://github.com/CodeEditApp/CodeEditSourceEditor) + CodeEditTextView (AppKit, Tree-sitter). Fallback if it fights us: ChimeHQ `STTextView` + `SwiftTreeSitter`. | Writing a code editor is a multi-year project. CodeMirror-in-WKWebView is rejected (not native). Runestone is iOS-first; Mac AppKit support is unfinished. |
| Markdown preview | **Library:** Apple `MarkdownUI` or `swift-markdown` into a native view; source still in the editor | Same toggle as today; do not render md inside the code editor. |
| File tree, git dirty badges, lazy expand | **Ours** (`NSOutlineView` / SwiftUI `List`) | Multi-root session worktrees, AgentDock change counts, untracked dirs — no library knows this. |
| Filename + content search UI | **Ours**, calling existing find API (same as `search-api.ts`) | Debounce split (fast names vs slow rg) is product logic. Hits open the editor at `line`. |
| Back/forward, mark line, visit stack | **Ours** — port `nav-history.ts` | Tiny, already tested; no library. |
| Go to definition / symbols / find usages | **Ours** — `/api/code` | Index lives on the server; UI is a picker + `open(path, line)`. |
| Open absolute path, save, conflict, note-to-agent | **Ours** — `/api/fs`, `/api/upload` | AgentDock-specific. |
| Ignore rules, ripgrep, name index | **Server, unchanged** | Do not duplicate in the app. |

**Do not** adopt a “full IDE explorer” (VS Code webview, SourceKit-LSP UI, Copilot Chat). We are not an IDE; we are a session-scoped browser over worktrees with an editor good enough to read and patch.

**iOS later:** reuse CodeEdit only if it supports UIKit; otherwise Runestone for the editor and the same server search APIs. Tree/search chrome stays ours.

**Parity gate (M3 Files):** every FileSearch / FileExplorer behavior in the current SPA — name search, content search, grouped hits, in-file match cycling that **scrolls**, ⌘[/] with line restore, external path, md preview/source, go-to-def, symbols, usages, dirty decorations, note-to-agent — must work and stay snappy on a large repo (chat). If the editor library cannot jump to a match index, it is the wrong library.

### 4.4 Server process

The Mac app starts `bun` on `server/src/index.ts` (dev: watch; release: bundled script or `bun build`). Bind **127.0.0.1:4800** by default.

- If 4800 is taken by an existing AgentDock, attach to it instead of failing (one host per machine).
- Show server logs in a debug window.
- Health: `GET /api/health`.
- SPA/Vite is **not** loaded in the Mac app. Release still can run the web client separately.

Auth for native:

- Mac: after server start, login via URLSession; store session in keychain; `Authorization` or cookie on API calls.
- iOS later: pairing token minted by Mac, not the account password in the clear on the LAN.

---

## 5. Mac app — implementation track (do this first)

### 5.0 What exists today (built, verified running)

Everything below lives in `macos/` and was verified against the real server and real
`claude-*` tmux sessions on this machine.

| Piece | File | State |
|---|---|---|
| Xcode project generated from a spec | `macos/project.yml`, `macos/scripts/bootstrap.sh` | XcodeGen; `bootstrap-ghostty.sh` downloads and checksums `GhosttyKit.xcframework` |
| SwiftUI shell, menus, Cmd+1..4 / Cmd+Shift+[ ] | `AgentDockApp.swift`, `ContentView.swift` | Sidebar + tab picker + per-session tab memory |
| Session list, 2s poll, keychain auth | `AppModel.swift`, `APIClient.swift` | Bearer token is `sha256("ad:<password>")`, stored in the login keychain; `AD_AUTH_TOKEN` overrides |
| Server lifecycle | `ServerSupervisor.swift` | Starts `bun run src/index.ts` only when port 4800 is unreachable; stops just the server it started |
| Ghostty runtime, clipboard, app focus | `GhosttyRuntime.swift` | `ghostty_init` + app, read/write clipboard callbacks, `ghostty_app_set_focus`, keyboard-layout changes |
| Persistent terminal surfaces | `GhosttyTerminalView.swift` | One `ghostty_surface_t` per session for the app's lifetime; tab and session switches only toggle visibility |
| Full key/mouse translation | `GhosttyInput.swift` + view | `ghostty_surface_key` with translation mods, unshifted codepoint, `NSTextInputClient` preedit, flagsChanged, buttons, precise scroll with momentum |
| Session management | `SessionSidebarView.swift`, `CreateSessionView.swift` | Search, queue/agent/repo grouping, sorting, pins/collapse preferences, create, restore, rename, kill, open in iTerm, agent switch |
| Files | `NativeFileExplorerView.swift`, `NativeCodeEditor.swift` | Lazy native tree, CodeEdit highlighting, go-to-def/usages, Cmd+[ history, outline, find, Markdown preview |
| Plan | `NativePlanView.swift`, `PlanDocument.swift` | Hash-aware polling, section outline with per-section progress, grouped code/table/quote rendering, inline markdown, highlighted raw mode, inline anchored comment lifecycle, send to agent |
| Changes | `NativeChangesView.swift`, `DiffModel.swift` | Parsed per-file hunks with old/new gutters, collapsible file cards, file sidebar with badges and ± counts, working-tree/PR diff switch, line-range review comments batched to the agent, open-in-Files, push, create/open PR |

Verified by driving the built app: the terminal paints an already-running Claude session
immediately, typed input reaches tmux (`echo` round-trip), and switching to Files and back
keeps the same surface alive and interactive.

Two findings worth keeping:

- `ghostty_surface_set_occlusion(surface, flag)` takes **visible**, not occluded. Passing the
  inverted flag makes libghostty emit `update_frame` and never `draw_frame`, so the view stays
  empty with no error anywhere. Renderer instrumentation (`renderer_event_cb`, enabled with
  `AGENTDOCK_GHOSTTY_LOG=1`) is what made this visible.
- libghostty installs and owns the surface view's backing layer (an `IOSurfaceLayer`). Do not
  set `wantsLayer`, do not override `makeBackingLayer`, and do not hand the view to SwiftUI
  directly — `TerminalHostView` exists so SwiftUI's layer management cannot replace it. Only
  `contentsScale` is ours to set.
- `GhosttyKit.xcframework` is a static archive: link it, never embed it, or code signing fails
  on `ghostty-internal.a`.
- Plan block ids are shared state, not a local detail. `PlanParser` in `PlanDocument.swift`
  reproduces the server's `blockIdFor()` — sha1 of the line with list markers and checkbox
  state stripped, truncated to 16 hex characters — and the two were compared output-for-output
  against `plan-comments.ts`. Presentation grouping (`PlanGroup`) therefore merges fenced code,
  tables and quotes for rendering only, keeping one id per source line; change the hashing and
  every comment written from the Mac app anchors somewhere else in the web UI.

Native Settings now covers all ten web categories through the same REST and preference files.
Notifications use `UNUserNotificationCenter`, preserve the web queue-bucket transition rules,
support overnight quiet hours, 30-second batching and optional 15-minute blocked reminders,
and clicking a session notification activates the app and selects that session. The Access pane
reads live network addresses, renders the pairing QR, and manages the AgentDock password and
ngrok basic auth. Web terminal controls remain shared preferences; native terminal controls stay
in Ghostty's own config so the app does not pretend an xterm setting can reconfigure libghostty.

Next: close the remaining M2/M3 parity gaps (templates/ticket launch fields, drag/bulk
session operations), then add native Worktrees, Sub-agents, and Queue.

### Layout in the repo (proposed)

```
macos/
  AgentDock.xcodeproj
  App/          SwiftUI app, process supervisor
  Terminal/     GhosttyKit wrapping, TerminalSurfaceStore
  Files/        native explorer + editor
  Plan/         native plan + comments
  Changes/      native git diff + PR
  Worktrees/
  Settings/
  API/          URLSession client for existing REST + WS
  Resources/    icons, sandbox entitlements
```

libghostty: vendor **GhosttyKit.xcframework** (cmux/Ghostty pattern). Do not fork Ghostty until we hit a missing C API. Read `~/.config/ghostty/config` for font/theme if cheap; otherwise match current AgentDock terminal theme.

Entitlements: outgoing network (localhost), subprocess (bun, tmux, git), user-selected folders if sandbox — **v1 should not be sandboxed** if that blocks tmux/worktrees; sandboxed Mac App Store is out of scope.

### Phase M0 — spike (days, throwaway OK)

Prove Ghostty can attach to an **existing** tmux session (`claude-*`) and:

- show a finished screen without a top-to-bottom sweep
- survive hide/show of the NSView without re-attach
- type into Claude/Cursor
- copy selection to the pasteboard (native, not tmux buffer)

If hide/show forces re-attach, we have learned we need a hidden window / offscreen surface, not “unmount the view.”

### Phase M1 — shell + session list

- App launches bun, waits for `/api/health`.
- Sidebar lists sessions from `GET /api/sessions` (3s poll is fine).
- Clicking a row shows/hides Ghostty surfaces (M0 store).
- Quit app leaves tmux running.
- Open in iTerm still works (existing endpoint).

**Gate:** switch among 10 sessions; none re-paints from empty; CPU of hidden sessions is idle-ish.

### Phase M2 — create / delete / agent switch

Call existing REST from SwiftUI create (templates, ticket/Slack, isolated, meta). Fix me / general chat / quick launches: native buttons, same `POST /api/sessions`.

**Gate:** create isolated Claude session from the Mac app; ticket- and template-based creates still work; delete removes tmux + surface.

### Phase M3 — native Files, Plan, Changes

Port the three rails to Swift. Feature parity with today’s React (see §2.3), same APIs. Ghostty stays mounted.

**Gate:**

- Files: open, grep, edit, save, md preview, in-file search jumps, back/forward, external path, note-to-agent
- Changes: diff, comment for the agent, push/PR
- Plan: read plan, comment, send to agent

Then M3b: worktrees, sub-agents, quiet/housekeeping (also native).

M3c: settings (all panes).

If Files/Plan/Changes are incomplete, the Mac app is not AgentDock.

### Phase M4 — polish the Mac terminal

- Resize: debounce; only the focused Ghostty surface is size authority; do not pin on every layout pass.
- Scroll: prefer Ghostty/tmux native scroll, not JSON `scroll` messages, once we are a real tmux client inside Ghostty (mouse off still, or Ghostty selection + tmux history — decide in spike).
- Fonts, theme, notifications: wrap existing `notify` semantics in `UNUserNotificationCenter` (local, no APNs yet).
- Do not port the opacity veil if Ghostty attach is clean; the veil is a web-xterm artifact.

**Gate:** open the Cursor-heavy session that used to sweep; switching to it is instant and visually stable. iTerm attached at another size may still glitch (accepted until v2).

### Phase M5 — Mac as size authority (pre-iOS)

Server changes:

- Attach options: `authority: true | false`.
- Non-authority clients: no `resize-window`; maybe no `settlePtyWindow`.
- `default-size` still set by the authority on detach.

Web client updated so a background Safari tab does not steal size from the Mac app.

**Gate:** Mac Ghostty at 140×50; `open-iterm` does not fill the Mac view with dots; web open letterboxes or uses Mac size.

This phase is still **Mac work**, but it is the contract iOS will use.

---

## 6. iOS companion — specified now, built after Mac

### Product v1

- Pair with this Mac (QR from Mac app — evolution of PhoneLink, not a public website).
- Session list + queue status (`blocked` / `review` / `working` / idle).
- Next blocked session.
- One terminal at a time (Ghostty UIView) including typing, Esc, paste.
- Local notification when a session goes waiting (APNs later; v1 can poll while open).
- If Mac is unreachable: clear error, retry; do not pretend to host agents.

**Not iOS v1** (Mac first; Safari fallback): create session, **native Files**, worktrees manager, housekeeping, full settings, extra shells, sub-agent tree, ngrok control, Android.

**iOS later:** native **Plan** and **Changes** (read-only first, share Mac Swift models), then Files if it can be simplified; create-from-phone still executes on Mac.

### Pairing

1. Mac app shows QR: `agentdock://pair?host=&port=&token=` (token one-time, LAN).
2. iOS stores host + device token; subsequent requests use `Authorization: Bearer`.
3. Server: new `/api/auth/device` mint/revoke; bind token to LAN or Tailscale later.
4. TLS: v1 may be HTTP on LAN like today; v2 mkcert or local CA. Document the risk.

Reuse `/api/network` address discovery so QR is not a stale DHCP IP.

### Transport

**iOS v1 (after Mac M5):** same WebSocket binary PTY as the web client, but rendered by Ghostty, and **non-authority** so it cannot resize the Mac window. Cold open still gets an attach paint; acceptable if Mac already holds the pin.

**iOS v2 if attach-on-phone still glitches:** replay protocol (grid snapshot + seq), cmux-style. Do not design this until iOS v1 is in hand. Mac M5 must not assume every client is a full tmux attach forever — keep a path to “push grid frames.”

Reconnect: freeze UI, exponential backoff, re-attach or replay; Mac tmux stays up.

### App structure (later)

```
ios/
  AgentDock.xcodeproj (or same workspace, iOS target)
  Pairing/, Sessions/, Terminal/ (GhosttyKit iOS)
```

Same GhosttyKit if upstream supports iOS; otherwise iOS waits on framework availability (cmux vendors a fork — we only fork if blocked).

### Notifications

Mac already has web notifications + session click-to-open. iOS: Mac server or Mac app pushes “session X is waiting.” v1: no push, in-app poll. v2: APNs via Mac relay (Mac is awake). Phone cannot see waiting sessions if Mac sleeps.

---

## 7. Cross-cutting rules (so Mac work does not trap iOS)

1. **Size authority** is a first-class attach parameter, not “whoever connected last.”
2. **Surface identity** is tmux session name (`claude-…`). iOS and Mac use the same id.
3. **Do not** key native UI lifetime to SwiftUI `id:` that recreates Ghostty (same bug as React `key={activeSession}`).
4. **Keep REST as the session source of truth.** Do not duplicate session lists in UserDefaults except pairing metadata.
5. **Input path:** keystrokes go to Ghostty → PTY/tmux, not `tmux send-keys` (length limits, already why we have PTY write).
6. **Large paste:** PTY write / tmux `load-buffer`, same as today.
7. **Mouse:** selection is Ghostty/AppKit; do not enable tmux mouse for AgentDock sessions.
8. **Web SPA** must keep working on 4800 for Linux/Windows/Safari; the Mac app does not load it.
9. **Tests:** server attach/authority behavior in Bun tests; Ghostty spikes are manual + later a tiny Mac UI test if feasible.
10. **Licensing:** Ghostty/libghostty is GPL. Shipping a Mac app that links it likely makes AgentDock’s native wrapper GPL. Confirm before any public binary. The existing MIT/web repo may need a split (GPL `macos/` + existing server). Resolve in M0, not at TestFlight.

---

## 8. Explicitly out of scope (until someone reopens)

- Electron / Tauri wrapping the SPA
- React Native desktop
- Android native
- Agents running on iPhone
- Embedding the React SPA in WKWebView as the Files/Plan/Changes UI (that is not a native app)
- Shipping a terminal-only Mac app and calling it AgentDock
- Ghostty portals through WKWebView
- Dropping tmux as persistence in M1
- App Store sandbox v1
- Parity with cmux splits, Tailscale, iPad, renderer reclaim at cmux depth

---

## 9. Suggested order of PRs / milestones

| # | Track | Deliverable |
|---|---|---|
| 1 | Mac M0 | Ghostty + existing tmux session, hide/show without re-attach |
| 2 | Repo | `macos/` Xcode project, bun supervisor, GPL note |
| 3 | Mac M1 | Session list + surface store |
| 4 | Mac M2 | Create/delete/switch-agent via REST |
| 5 | Mac M3 | Native Files + Plan + Changes (parity with current React) |
| 5b | Mac M3b | Native worktrees, sub-agents, quiet/housekeeping |
| 5c | Mac M3c | Native create + settings (all panes) |
| 6 | Server | Attach `authority` flag; web client respects it |
| 7 | Mac M4–M5 | Resize/selection/notifications; Mac is size authority |
| 8 | iOS | Pairing + list + Ghostty view, non-authority attach |
| 9 | Later | Replay / Tailscale / APNs / Mac v2 PTY ownership |

Do not start row 8 until row 7’s gate passes. iOS on today’s “every attach pins size” will reproduce the sweep on a small screen.

---

## 10. First conversation after compaction

Read this file. Then:

1. Confirm GPL/Ghostty packaging with the user if shipping outside this machine.
2. Start Mac M0 only: Xcode + GhosttyKit + attach to one live `claude-*` session.
3. Next Mac milestone after session list is **native Files, Plan, Changes** — not a WebView of the SPA. Do not start iOS until Mac M5.

Related code (web, still the host):

- `server/src/routes/ws.ts` — attach + batching
- `server/src/services/tmux-pty.ts` — pin, settle, default-size
- `client/src/components/TerminalView.tsx` — xterm lifetime, veil
- `client/src/pages/Dashboard.tsx` — rail surfaces, `key={activeSession}`
- `client/src/pages/CreateSession.tsx` — create form
- `client/src/components/FileExplorer.tsx`, `ChangesView.tsx`, `PlanView.tsx`, `WorktreesView.tsx`, `SettingsModal.tsx`, `QuietView.tsx`, `SubAgentsView.tsx`
- `client/src/components/Header.tsx` — fix me, general chat, quick launches, ngrok
- `server/src/services/session-manager.ts` — `launchAgent` / tmux create
- `client/src/components/PhoneLink.tsx` — LAN URL (iOS pairing precursor)
