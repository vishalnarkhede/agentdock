#!/bin/bash
# AgentDock status hook for Claude Code.
# Called by Claude's Stop and Notification hooks to report session status.
# Writes status to /tmp/agentdock-status/<tmux-session> so the server can read it.
#
# Usage: Receives JSON on stdin from Claude hooks with session_id, cwd, etc.
# Arg $1: "stop" (Claude finished responding) or "waiting" (Claude idle at prompt)

set -euo pipefail

STATUS_DIR="/tmp/agentdock-status"
mkdir -p "$STATUS_DIR"

STATUS="${1:-unknown}"

# The tmux session name is passed via TMUX_PANE env or we derive from the parent tmux session.
# Claude Code hooks inherit the tmux environment, so TMUX is set.
if [ -n "${TMUX:-}" ]; then
  SESSION_NAME=$(tmux display-message -p '#{session_name}' 2>/dev/null || echo "")
else
  SESSION_NAME=""
fi

if [ -z "$SESSION_NAME" ]; then
  exit 0
fi

# Write status with timestamp
echo "{\"status\":\"${STATUS}\",\"ts\":$(date +%s)}" > "${STATUS_DIR}/${SESSION_NAME}"
