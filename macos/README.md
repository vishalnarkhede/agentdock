# AgentDock for macOS (native)

A native Mac client for AgentDock. Terminals are real libghostty surfaces attached to the
same `claude-*` tmux sessions the web client uses, and they stay alive for the lifetime of the
app: switching tabs or sessions only shows and hides an existing surface.

The full product plan lives in [`../docs/native-mac-ios-plan.md`](../docs/native-mac-ios-plan.md).

## Requirements

- Xcode 16 or newer
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)
- `bun`, `tmux`, `git` on `PATH` (the app starts the AgentDock server itself when needed)

## Build and run

```bash
cd macos
./scripts/bootstrap.sh   # downloads GhosttyKit.xcframework, generates AgentDock.xcodeproj
open AgentDock.xcodeproj # or build from the command line:

xcodebuild -project AgentDock.xcodeproj -scheme AgentDock \
  -configuration Debug -derivedDataPath DerivedData \
  -skipPackagePluginValidation build
./DerivedData/Build/Products/Debug/AgentDock.app/Contents/MacOS/AgentDock
```

`Frameworks/` and `DerivedData/` are generated and git-ignored. Re-run
`./scripts/bootstrap.sh` after adding or removing source files.

## Authentication

If AgentDock has a password set, the app asks for it once and stores the derived bearer token
(`sha256("ad:<password>")`) in the login keychain. `AD_AUTH_TOKEN` in the environment takes
precedence, which is handy when launching from a terminal.

## Keyboard

| Shortcut | Action |
|---|---|
| Cmd+1 … Cmd+4 | Terminal / Files / Plan / Changes |
| Cmd+[ / Cmd+] | Editor back / forward (also Cmd+{ / Cmd+} while Files is open) |
| Cmd+Shift+] / Cmd+Shift+[ | Next / previous session (Files tab remaps these to editor history) |
| Cmd+F | Find in the current file |
| Ctrl+Cmd+J or Cmd-click | Go to definition; click again on the definition to list usages |
| Cmd+Shift+O | File outline |
| Cmd+S | Save the open file |
| Cmd+R | Reload session list |
| Cmd+C / Cmd+V / Cmd+A | Copy selection, paste, select all in the terminal |

## Debugging the terminal

```bash
AGENTDOCK_GHOSTTY_LOG=1 ./DerivedData/Build/Products/Debug/AgentDock.app/Contents/MacOS/AgentDock
```

This logs surface creation, resolved grid size, the backing layer class, and libghostty
renderer events. A surface that reports `update_frame` events but never `draw_frame` is not
being drawn at all — check the visibility flag passed to `ghostty_surface_set_occlusion`
before looking anywhere else.

## Status

Working:

- Feature-rich session sidebar: search, queue/agent/repository grouping, sorting, pins,
  persisted collapsed groups, parent/child rows, metadata, create, restore, rename, kill,
  open in iTerm, and Claude/Cursor switching.
- Persistent Ghostty terminals with keyboard and mouse input including IME preedit and
  precise scrolling, clipboard, server supervision, and keychain auth. Attach joins
  tmux with `ignore-size` at the current window grid so opening a session does not
  replay the agent TUI. Maximize and other real window resizes then grow Ghostty and
  `resize-window` to fill the view.
- Native Files: lazy directory tree, staged name/content search that survives opening a
  result, absolute read-only opens, CodeEdit syntax highlighting, Cmd-click / ⌃⌘J
  go-to-definition (references when already on the declaration), Cmd+[ history with line
  restore, outline, find/replace, minimap, editable source, optimistic-concurrency saves,
  conflict recovery, Markdown Preview/Source, and selected-code notes to the agent with path
  and line context.
- Language-server navigation: Cmd-click resolves through gopls, tsserver, pyright and
  sourcekit-lsp rather than a regex table, carries the unsaved buffer so a lookup matches
  what is on screen, and falls back to AgentDock's symbol index for anything without a
  server. Pool state is visible under Settings → Health. See
  [docs/code-intelligence.md](../docs/code-intelligence.md).
- Native Plan: 4-second hash-aware polling, section outline with per-section checklist
  progress, grouped code cards and real markdown tables, inline bold/italic/code/links,
  progress ring, syntax-highlighted raw markdown, inline anchored comments with
  resolve/reopen/delete, orphan state, and batched “send to agent.”
- Native Changes: per-file diff cards with old/new line gutters, collapsible files, a file
  sidebar with change badges and ± counts, working-tree/pull-request diff switching, line-range
  review comments batched into one agent message, open-in-Files jumps, multi-repository
  selection, refresh, push, create/open PR, and notes to the agent.
- Native Settings: the same ten categories as the web dashboard—repository and base-path CRUD,
  default agent and permission policy, actionable notifications with quiet hours/batching/
  reminders, worktree preferences, editable session-property presets, phone addresses,
  password and ngrok protection, appearance, web-terminal preferences, tool and hook health,
  and native shortcuts. Shared values persist through `preferences.json`; Ghostty-specific
  terminal behavior remains in `~/.config/ghostty/config`.

Still to build for full web parity: session drag reorder and bulk/meta actions,
Slack/attachment launch fields, worktree and sub-agent panes, extra shells, advanced Files
search/decorations, remaining queue shortcuts, and header quick actions. The audited,
implementation-level backlog is in `../docs/native-parity-audit.md`.
