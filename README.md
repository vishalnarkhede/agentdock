# AgentDock

**Stop managing AI coding agents like terminal tabs.**

Mission control for parallel [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions. Run a fleet across repos from one local-first cockpit — desktop or phone. See who is working, who needs you, review the diff, and jump in.

<img width="1536" height="1024" alt="AgentDock dashboard: session queue and live terminal" src="https://github.com/user-attachments/assets/cf8f345c-7a43-44b1-8346-831dc6751923" />

- Parallel Claude Code sessions
- Isolated git worktrees
- Live working / waiting / done status
- Plans and diffs before you merge
- The same UI on your phone
- Local-first — your machine, no cloud

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/vishalnarkhede/agentdock/main/install.sh | bash
agentdock web
```

Or clone it yourself:

```bash
git clone https://github.com/vishalnarkhede/agentdock.git
cd agentdock
./setup.sh
agentdock web
```

`./setup.sh` installs [Bun](https://bun.sh/) and [tmux](https://github.com/tmux/tmux) if they are missing, then prints a checklist. Claude Code is only required when you start an agent — the UI opens without it.

```text
  ✓ git
  ✓ bun
  ✓ tmux
  ! claude CLI — needed to start an agent
    https://docs.anthropic.com/en/docs/claude-code
    then: claude login
```

Re-run the checklist anytime with `agentdock doctor`.

First launch asks where your repos live and which ones to add. Password, Linear, Slack, and ngrok are optional and live in Settings.

Opens http://localhost:5173 (API on port 4800).

## What changes

**Before**

```text
Terminal 1: Claude fixing auth
Terminal 2: Claude doing tests
Terminal 3: another repo
Terminal 4: forgotten agent waiting for permission
Terminal 5: git diff
Phone: useless
```

**After**

```text
One dashboard
  3 working
  1 needs input
  2 ready for review
```

## Three ways people use it

**Run a team of tasks.** Start several Claude sessions across one repo or many. Isolated worktrees keep branches from colliding. The queue shows working / waiting / done from Claude Code hooks — not by scraping the terminal.

**Review before you merge.** Open the plan the agent wrote, read the live diff, comment, and send a follow-up without leaving the session. Restore a stopped session and the conversation comes back.

**Walk away.** The same UI is built for a phone. Start four jobs on a laptop, close it, answer the one that needs input from your pocket. On the LAN use `https://<your-ip>:5173`; away from home, toggle ngrok in the header.

## Why this exists

I got tired of Cursor eating RAM, of not being a terminal person, and of features that span four repos. Sometimes I just need things to keep moving while walking the baby at 2am. If that sounds familiar, this is for you — [say hello on X](https://x.com/vishtree1992).

AgentDock is under active development. [Bug reports and feedback](https://github.com/vishalnarkhede/agentdock/issues) are welcome.

## CLI

```bash
agentdock start my-repo                # launch an agent
agentdock start -r repo1 repo2         # one session, several repos
agentdock start my-repo --isolated     # isolated git worktree
agentdock doctor                       # what is missing
agentdock repos                        # configured repos
agentdock list                         # active sessions
agentdock stop --all                   # kill them
```

## Using from your phone

1. `agentdock web` on the Mac or Linux box (it binds on the LAN).
2. Your IP: `ipconfig getifaddr en0` (macOS) or `hostname -I` (Linux).
3. On the phone, open `https://<your-ip>:5173`. The self-signed cert warning is expected on the local network — Advanced → Proceed.
4. Add to the home screen if you want it full-screen.

Away from home, turn on ngrok in the header and open the public HTTPS URL.

## Configuration

Everything lives in `~/.config/agentdock/`. No database.

Repos are added on first launch or later under **Settings > Repositories** (scan a folder, add by path, remove). Or write `repos.json` yourself:

```json
[
  { "alias": "backend", "folder": "my-backend", "remote": "org/my-backend" },
  { "alias": "frontend", "folder": "my-frontend", "remote": "org/my-frontend" }
]
```

Default base directory is `~/projects`. Override with `AGENTDOCK_BASE_PATH`.

| File | Purpose |
|---|---|
| `~/.config/agentdock/auth-password` | Optional password for the web UI |

MCP servers (for example [Linear](https://github.com/linear/linear-mcp)) are added under **Settings > MCP Servers** and synced into agent configs.

[Cortex](https://github.com/hjertefolger/cortex) is a good companion if you want Claude sessions to remember things across restarts.

## How it works

See [ARCHITECTURE.md](./ARCHITECTURE.md) for internals.

1. Create a session — pick repos, optionally isolate with a worktree.
2. The agent starts in tmux with tools for files, git, and `gh`.
3. Status comes from Claude Code hooks (`PreToolUse`, `Stop`, `Notification`, …) written to `/tmp/agentdock-status/`.
4. The browser attaches through a PTY and streams the real terminal over WebSocket.
5. Plans land in `~/.config/agentdock/plans/`. The Changes tab is a live git diff.
6. Restore finds the last Claude conversation and runs `claude --resume <uuid>`.
7. Stop kills tmux and removes worktrees you asked it to create.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+[` / `Ctrl+Shift+]` | Previous / next session (MRU) |
| `Cmd+F` | Search inside a file (Files tab) |
| `Esc` | Collapse the plan / changes / files panel |

## Also built in

Agent switching mid-conversation, session templates, pinning and grouping, custom session properties, Slack-to-fix, browser notifications, optional password. Cursor Agent works but is experimental. To plug in another CLI agent, see [AGENTS.md](./AGENTS.md).

## Security

Local-first. The server binds to your machine. State is files, not a hosted database. Optional hashed password in `~/.config/agentdock/auth-password`. Each session is its own tmux session with configurable tools.

Report vulnerabilities via [SECURITY.md](./SECURITY.md).

## Platform

| Platform | Status |
|---|---|
| macOS | Supported |
| Linux (Ubuntu/Debian) | Supported |
| Windows | WSL only (tmux) |

## FAQ

**Why tmux?** Persistent sessions and a real terminal without writing a process supervisor.

**Why Bun?** Fast start, TypeScript, native WebSockets.

**Why no database?** tmux holds the live session; a few JSON files hold config.

**Remote access?** Set a password and use the LAN, ngrok, SSH, or a reverse proxy.

**Status?** Claude hooks write `/tmp/agentdock-status/`. Cursor falls back to matching the terminal.

**Restore?** Latest conversation UUID from `~/.claude/projects/` is passed to `claude --resume`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — [LICENSE](./LICENSE).
