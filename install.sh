#!/usr/bin/env bash
# One-command install:
#   curl -fsSL https://raw.githubusercontent.com/vishalnarkhede/agentdock/main/install.sh | bash
set -euo pipefail

DEST="${AGENTDOCK_HOME:-${HOME}/.local/share/agentdock}"

if [[ -d "${DEST}/.git" ]]; then
  echo "Updating AgentDock in ${DEST}"
  git -C "$DEST" pull --ff-only
else
  echo "Cloning AgentDock into ${DEST}"
  mkdir -p "$(dirname "$DEST")"
  git clone --depth 1 https://github.com/vishalnarkhede/agentdock.git "$DEST"
fi

exec "$DEST/setup.sh"
