#!/bin/bash
# One-time script to inform all existing Claude sessions about the messaging system.
# Run this once to enable behind-the-curtain communication for sessions that were
# created before the system prompt was updated.

MESSAGE='IMPORTANT SYSTEM UPDATE: You now have cross-session messaging via the agentdock MCP server. After completing each task, call `check_messages` with your session name to see if other sessions have questions for you. If there are pending messages, reply using `reply_message`. You can also send messages to other sessions with `send_message`. This enables the project overseer (Jacek) to coordinate with you invisibly. Acknowledge with a brief "understood" and continue your current work.'

echo "Broadcasting messaging update to all Claude sessions..."
echo ""

for session in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^claude-'); do
  # Skip Jacek
  if [ "$session" = "claude-jacek-overseer" ]; then
    continue
  fi

  echo "  → $session"
  tmux send-keys -t "$session" "$MESSAGE" Enter
done

echo ""
echo "Done. All sessions have been notified."
