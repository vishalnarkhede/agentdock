# Native macOS parity audit

Audited against the React client and every Hono route on 2026-08-28. This is
the implementation truth; `native-mac-ios-plan.md` remains the product roadmap.

## Shipped and verified in this pass

- Files can send a note about selected code to the active agent. The message
  includes the repository-relative path, exact line range, language fence, and
  selection, with the same 120-line / 6000-character caps as the web client.
- File-save HTTP 409 responses reach the existing Reload/Overwrite conflict UI.
- Agent switching consumes the SSE stream and reports streamed failures.
- Bearer-authenticated native sessions report as logged in.
- Hook installation returns the same event schema as hook status.
- Native notifications present in the foreground, batched notifications open
  a relevant session, and recurring reminders are not reset on every poll.
- The native queue now has a global attention summary, blocked-session chips,
  cost-ordered Next navigation, and a quiet state with stale-session restore.
- Native creation now loads/saves/deletes templates, parses Linear IDs and
  URLs into the brief, supports repository-free Just Talk sessions, and sends
  configured session metadata.

Verification: native Debug build succeeds, file-note contract tests pass, and
the server suite passes (375 tests).

## P0 — core daily-driver gaps

| Area | Missing or partial behavior | Existing backend |
|---|---|---|
| Queue | Bare `N` shortcut and housekeeping details; attention/Next/Quiet are implemented | `GET /api/housekeeping`, `GET /api/review/*` |
| Create | Slack thread paste, attachments, recent/primary repository UX | `POST /api/upload`, preferences |
| Panes | Dedicated Sub-agents and Worktrees views | session children, `/api/worktrees` |
| Terminal coexistence | Native Ghostty and web PTY can both resize the same tmux window | tmux transport needs one size owner |

## P1 — high-value parity work

| Area | Missing or partial behavior |
|---|---|
| Create | Slack paste, recent/primary repo, attachments |
| Sessions | Meta editing, bulk kill, drag reorder, MRU/frequent sort, nested child controls |
| Terminal | Extra shells and progress UI for agent switching |
| Files | Debounced advanced search, workspace-hit highlighting, git tree badges, definition picker |
| Header | Fix Me, General Chat, quick launches, phone shortcut, ngrok start/stop |
| Network | A native-started app does not host the mobile web client, so Phone Link may have no usable port |
| Lifecycle | Rename does not migrate in-memory terminal/editor/plan/change state |
| Performance | Session polling continues while the app is hidden; plan comments refetch independently |

## Settings that currently overpromise

These values persist but are not consumed by runtime code:

- `worktreePostCreate`
- `worktreeBranchPrefix`
- `worktreeAutoRemove`

The web client also exposes notification batching and reminders without
implementing them. Native implements both. Native theme selection currently
maps the web themes to light or dark appearance rather than reproducing all
theme palettes. Web terminal preferences intentionally do not configure
Ghostty; Ghostty still uses `~/.config/ghostty/config`.

Until the worktree settings are wired into `session-manager.ts`, `worktree.ts`,
and housekeeping, their controls should not be described as active behavior.

## P2 — polish and platform differences

- Status grouping, session-type badges, copy-name/path actions, and first-run setup.
- Search-index status/reindex UI, install hints in Health, and complete shortcut documentation.
- GFM-complete Markdown preview and exact web theme palettes.
- Mobile queue, touch selection, and custom mobile keyboard are web/iOS concerns,
  not native macOS parity requirements.

## API coverage snapshot

Native already covers sessions, preferences, repository settings, auth,
filesystem read/write, code navigation, plans/comments, Git changes/PR/push,
health/hooks, and phone-link discovery.

Native does not yet expose session reorder/shells/meta/bulk delete, templates,
worktrees, review/housekeeping, ngrok tunnel lifecycle, uploads, repository
scanning, quick actions, MCP names, search-index controls, or DB shard tools.
DB shard APIs currently have no web UI consumer and are not a parity priority.
