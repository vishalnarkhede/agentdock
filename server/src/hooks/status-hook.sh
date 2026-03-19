#!/bin/bash
# AgentDock status hook for Claude Code.
# Called by Claude lifecycle hooks to report session status.
# Writes status to /tmp/agentdock-status/<tmux-session> so the server can read it.
#
# Hook events → status mapping:
#   PreToolUse       → "working"  (tool about to run — agent is active)
#   UserPromptSubmit → "working"  (user sent input)
#   SubagentStop     → "working"  (sub-agent done, parent still active)
#   Stop             → "waiting"  (Claude finished responding)
#   Notification     → "waiting"  (idle at prompt)

STATUS_DIR="/tmp/agentdock-status"
mkdir -p "$STATUS_DIR"

STATUS="${1:-unknown}"

# Derive tmux session name from environment
if [ -n "${TMUX:-}" ]; then
  SESSION_NAME=$(tmux display-message -p '#{session_name}' 2>/dev/null || echo "")
else
  SESSION_NAME=""
fi

[ -z "$SESSION_NAME" ] && exit 0

# Write status with timestamp
echo "{\"status\":\"${STATUS}\",\"ts\":$(date +%s)}" > "${STATUS_DIR}/${SESSION_NAME}"
