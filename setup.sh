#!/usr/bin/env bash
set -euo pipefail

# Installs bun/tmux if needed, dependencies, and the CLI.
# Non-interactive by default. Pass --interactive to prompt for Linear/Slack keys.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_SOURCE="${SCRIPT_DIR}/bin/agentdock"
BIN_TARGET="${HOME}/bin/agentdock"
CONFIG_DIR="${HOME}/.config/agentdock"
INTERACTIVE=false

for arg in "$@"; do
  case "$arg" in
    --interactive|-i) INTERACTIVE=true ;;
    -h|--help)
      echo "Usage: ./setup.sh [--interactive]"
      echo "  Installs AgentDock. Optional --interactive asks for Linear/Slack keys."
      exit 0
      ;;
  esac
done

echo "── AgentDock setup ──"
echo ""

mkdir -p "$CONFIG_DIR"

if command -v bun &>/dev/null; then
  echo "[ok] bun $(bun --version)"
else
  echo "[installing] bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="${HOME}/.bun/bin:${PATH}"
  echo "[ok] bun $(bun --version)"
fi

if command -v tmux &>/dev/null; then
  echo "[ok] tmux $(tmux -V)"
else
  if command -v brew &>/dev/null; then
    echo "[installing] tmux via homebrew..."
    brew install tmux
    echo "[ok] tmux $(tmux -V)"
  elif command -v apt &>/dev/null; then
    echo "[installing] tmux via apt..."
    sudo apt install -y tmux
    echo "[ok] tmux $(tmux -V)"
  else
    echo "[error] tmux not found. Install it, then re-run ./setup.sh"
    echo "  macOS:  brew install tmux"
    echo "  Linux:  sudo apt install tmux"
    exit 1
  fi
fi

echo ""
echo "Installing dependencies..."
(cd "$SCRIPT_DIR" && bun install)

echo ""
mkdir -p "${HOME}/bin"
chmod +x "$BIN_SOURCE" "${SCRIPT_DIR}/bin/ad-agent" "${SCRIPT_DIR}/scripts/doctor.sh"
cp "$BIN_SOURCE" "$BIN_TARGET"
cp "${SCRIPT_DIR}/bin/ad-agent" "${HOME}/bin/ad-agent"
chmod +x "$BIN_TARGET" "${HOME}/bin/ad-agent"
echo "[ok] installed agentdock → ${BIN_TARGET}"

if ! echo "$PATH" | tr ':' '\n' | grep -qx "${HOME}/bin"; then
  echo ""
  echo "[action] Add ~/bin to PATH in ~/.zshrc or ~/.bashrc:"
  echo "  export PATH=\"\$HOME/bin:\$PATH\""
fi

if $INTERACTIVE; then
  echo ""
  echo "── Optional integrations (Enter skips) ──"
  echo ""
  CURRENT_BASE="${HOME}/projects"
  [[ -f "${CONFIG_DIR}/base-path" ]] && CURRENT_BASE="$(tr -d '[:space:]' < "${CONFIG_DIR}/base-path")"
  read -rp "Repo base path [${CURRENT_BASE}]: " user_base
  if [[ -n "$user_base" ]]; then
    echo "$user_base" > "${CONFIG_DIR}/base-path"
    echo "  saved: ${user_base}"
  fi
  if [[ ! -f "${CONFIG_DIR}/linear-api-key" ]]; then
    read -rp "Linear API key (optional): " linear_key
    if [[ -n "$linear_key" ]]; then
      echo "$linear_key" > "${CONFIG_DIR}/linear-api-key"
      chmod 600 "${CONFIG_DIR}/linear-api-key"
    fi
  fi
  if [[ ! -f "${CONFIG_DIR}/linear-team-id" ]]; then
    read -rp "Linear team ID (optional): " linear_team
    if [[ -n "$linear_team" ]]; then
      echo "$linear_team" > "${CONFIG_DIR}/linear-team-id"
    fi
  fi
  if [[ ! -f "${CONFIG_DIR}/slack-token" ]]; then
    read -rp "Slack bot token (optional): " slack_token
    if [[ -n "$slack_token" ]]; then
      echo "$slack_token" > "${CONFIG_DIR}/slack-token"
      chmod 600 "${CONFIG_DIR}/slack-token"
    fi
  fi
fi

echo ""
"${SCRIPT_DIR}/scripts/doctor.sh" || true

echo ""
echo "── Setup complete ──"
echo ""
echo "  agentdock web"
echo ""
echo "The first launch walks you through repos. Claude, Linear, and Slack"
echo "can be added later in Settings — you do not need them to open the UI."
echo ""
