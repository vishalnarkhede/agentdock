#!/bin/bash
# One-time script to inform all existing Claude sessions about the messaging system.
# Since existing sessions don't have the agentdock MCP loaded, we point them to
# helper scripts they can run via Bash.

SCRIPTS_DIR="/Users/vishal/projects/agentdock/scripts"

echo "Broadcasting messaging update to all Claude sessions..."
echo ""

for session in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^claude-'); do
  if [ "$session" = "claude-jacek-overseer" ]; then
    continue
  fi

  MSG="NEW: A project overseer coordinates across sessions. After completing each task, run: bash ${SCRIPTS_DIR}/ad-check-messages.sh ${session} — to check for pending questions from the overseer. If you get messages, reply with: bash ${SCRIPTS_DIR}/ad-reply-message.sh MESSAGE_ID \"your reply\" — When you create a PR, register it: bash ${SCRIPTS_DIR}/ad-register-pr.sh REPO URL TITLE FEATURE ${session} — Acknowledge briefly and continue your work."

  echo "  → $session"
  tmux send-keys -t "$session" "$MSG" Enter
done

echo ""
echo "Done. All sessions have been notified."
