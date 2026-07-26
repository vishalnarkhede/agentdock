#!/bin/bash
# AgentDock plan hook for Claude Code.
#
# Copies a plan written by Claude Code's plan mode into AgentDock's plans dir, so
# the Plan tab can find it.
#
# Agents AgentDock launches are told where to write their plan by the injected
# system prompt, and that instruction is agent-agnostic — it works for Codex and
# Cursor too, which have no plan mode. This hook is the backstop for the case the
# prompt cannot reach: an agent the user started themselves in their own tmux pane,
# which never sees AgentDock's system prompt at all.
#
# The key is the tmux pane, not the session, because several agents commonly share
# one session — and it matches the `external-<n>` name the server gives those
# agents, so the existing per-session lookup finds the file with no extra mapping.
#
# Registered on PostToolUse (Write|Edit) synchronously — see syncHooksToClaudeSettings
# for why. Runs on every Write and Edit, so it bails as early as it can.

set -uo pipefail

# Bounded read: if stdin is ever not provided, this must not hang a tool call.
# `read -t` is a bash builtin, unlike timeout(1), which stock macOS does not ship —
# with timeout(1) this whole hook silently no-opped there. -d '' reads to EOF, so
# the non-zero exit on EOF is expected and INPUT is still populated.
IFS= read -r -d '' -t 2 INPUT || true
[ -z "${INPUT:-}" ] && exit 0

# jq is not one of AgentDock's required tools. Without it, do nothing rather than
# risk mangling the payload with string matching.
command -v jq >/dev/null 2>&1 || exit 0

FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)
[ -z "$FILE_PATH" ] && exit 0

# Only Claude Code's plan-mode files. An agent writing straight to AgentDock's plans
# dir does not match this, so the two paths never fight over the same file.
case "$FILE_PATH" in
  */.claude/plans/*.md) ;;
  *) exit 0 ;;
esac

[ -f "$FILE_PATH" ] || exit 0
[ -n "${TMUX:-}" ] || exit 0

PANE_ID=$(tmux display-message -p '#{pane_id}' 2>/dev/null || true)
SESSION_NAME=$(tmux display-message -p '#{session_name}' 2>/dev/null || true)
[ -n "$PANE_ID" ] || exit 0

# AgentDock's own sessions are keyed by session name — the same path its system
# prompt names — so the hook reinforces that instruction instead of competing with
# it. "claude-" mirrors PREFIX in services/config.ts.
case "$SESSION_NAME" in
  claude-*) KEY="$SESSION_NAME" ;;
  *)        KEY="external-${PANE_ID#%}" ;;
esac

# hooks/ and plans/ are siblings under the config dir, so this follows
# AGENTDOCK_CONFIG_DIR without needing to be told where it is.
# Test the resolved config dir, not the concatenation: if the cd fails the
# substitution is empty and "${empty}/plans" is "/plans", which is non-empty and
# would sail past this guard.
CONFIG_DIR="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)"
[ -n "$CONFIG_DIR" ] || exit 0
PLANS_DIR="${CONFIG_DIR}/plans"
mkdir -p "$PLANS_DIR" 2>/dev/null || exit 0

cp "$FILE_PATH" "${PLANS_DIR}/${KEY}.md" 2>/dev/null || true

# Always succeed: a failure here must never surface as a tool error.
exit 0
