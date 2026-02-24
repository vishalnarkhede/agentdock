#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────
# agentdock setup
# Installs prerequisites, dependencies, and the CLI tool.
# ─────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_SOURCE="${SCRIPT_DIR}/bin/agentdock"
BIN_TARGET="${HOME}/bin/agentdock"
CONFIG_DIR="${HOME}/.config/agentdock"

echo "── agentdock setup ──"
echo ""

# 0. Create config directory
mkdir -p "$CONFIG_DIR"

# 1. Check / install bun
if command -v bun &>/dev/null; then
  echo "[ok] bun $(bun --version)"
else
  echo "[installing] bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="${HOME}/.bun/bin:${PATH}"
  echo "[ok] bun $(bun --version)"
fi

# 2. Check / install tmux
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
    echo "[error] tmux not found. Install it:"
    echo "  macOS:  brew install tmux"
    echo "  Linux:  sudo apt install tmux"
    exit 1
  fi
fi

# 3. Check claude CLI
if command -v claude &>/dev/null; then
  echo "[ok] claude CLI found"
else
  echo "[warn] claude CLI not found in PATH"
  echo "  Install: https://docs.anthropic.com/en/docs/claude-code"
fi

# 4. Check gh CLI
if command -v gh &>/dev/null; then
  echo "[ok] gh $(gh --version | head -1)"
else
  echo "[warn] gh CLI not found (optional, needed for PR features)"
  echo "  Install: brew install gh"
fi

# 5. Install ffmpeg (required by mlx-whisper for audio decoding)
if command -v ffmpeg &>/dev/null; then
  echo "[ok] ffmpeg found"
else
  if command -v brew &>/dev/null; then
    echo "[installing] ffmpeg via homebrew..."
    brew install ffmpeg
    echo "[ok] ffmpeg installed"
  else
    echo "[warn] ffmpeg not found. Install it for voice input support:"
    echo "  macOS:  brew install ffmpeg"
    echo "  Linux:  sudo apt install ffmpeg"
  fi
fi

# 6. Install Python dependencies for voice input (whisper server)
echo ""
echo "Setting up whisper server (voice input)..."
VENV_DIR="${SCRIPT_DIR}/.venv"
if [[ ! -d "$VENV_DIR" ]]; then
  python3 -m venv "$VENV_DIR"
fi
"${VENV_DIR}/bin/pip" install -q mlx-whisper fastapi uvicorn python-multipart 2>/dev/null || {
  echo "[warn] whisper dependencies install failed — voice input may not work"
}
echo "[ok] whisper venv ready"

# 7. Install node dependencies
echo ""
echo "Installing dependencies..."
(cd "$SCRIPT_DIR" && bun install)

# 8. Install CLI tools to ~/bin
echo ""
mkdir -p "${HOME}/bin"
chmod +x "$BIN_SOURCE"
cp "$BIN_SOURCE" "$BIN_TARGET"
chmod +x "$BIN_TARGET"
echo "[ok] installed agentdock → ${BIN_TARGET}"

AD_AGENT_SOURCE="${SCRIPT_DIR}/bin/ad-agent"
AD_AGENT_TARGET="${HOME}/bin/ad-agent"
chmod +x "$AD_AGENT_SOURCE"
cp "$AD_AGENT_SOURCE" "$AD_AGENT_TARGET"
chmod +x "$AD_AGENT_TARGET"
echo "[ok] installed ad-agent → ${AD_AGENT_TARGET}"

# Check if ~/bin is in PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "${HOME}/bin"; then
  echo ""
  echo "[action needed] Add ~/bin to your PATH. Add this to your ~/.zshrc or ~/.bashrc:"
  echo ""
  echo "  export PATH=\"\$HOME/bin:\$PATH\""
  echo ""
fi

# 9. Interactive configuration (skippable)
echo ""
echo "── Configuration (press Enter to skip any step) ──"
echo ""

# Base path
CURRENT_BASE="${HOME}/projects"
[[ -f "${CONFIG_DIR}/base-path" ]] && CURRENT_BASE="$(cat "${CONFIG_DIR}/base-path" | tr -d '[:space:]')"
read -rp "Repo base path [${CURRENT_BASE}]: " user_base
if [[ -n "$user_base" ]]; then
  echo "$user_base" > "${CONFIG_DIR}/base-path"
  echo "  saved: ${user_base}"
fi

# Linear API key
if [[ -f "${CONFIG_DIR}/linear-api-key" ]]; then
  echo "Linear API key: configured"
else
  read -rp "Linear API key (lin_api_..., optional): " linear_key
  if [[ -n "$linear_key" ]]; then
    echo "$linear_key" > "${CONFIG_DIR}/linear-api-key"
    chmod 600 "${CONFIG_DIR}/linear-api-key"
    echo "  saved"
  fi
fi

# Linear team ID
if [[ -f "${CONFIG_DIR}/linear-team-id" ]]; then
  echo "Linear team ID: configured"
else
  read -rp "Linear team ID (UUID, optional): " linear_team
  if [[ -n "$linear_team" ]]; then
    echo "$linear_team" > "${CONFIG_DIR}/linear-team-id"
    echo "  saved"
  fi
fi

# Slack token
if [[ -f "${CONFIG_DIR}/slack-token" ]]; then
  echo "Slack token: configured"
else
  read -rp "Slack bot token (xoxb-..., optional): " slack_token
  if [[ -n "$slack_token" ]]; then
    echo "$slack_token" > "${CONFIG_DIR}/slack-token"
    chmod 600 "${CONFIG_DIR}/slack-token"
    echo "  saved"
  fi
fi

echo ""
echo "── Setup complete ──"
echo ""
echo "Start the web dashboard:"
echo ""
echo "  agentdock web"
echo ""
echo "Configure repos and integrations in the browser:"
echo ""
echo "  http://localhost:5173/settings"
echo ""
echo "Or use the CLI directly:"
echo ""
echo "  agentdock start my-repo"
echo "  agentdock repos"
echo ""
echo "For voice input, start the whisper server:"
echo ""
echo "  ${VENV_DIR}/bin/python bin/whisper-server.py"
echo ""
echo "(First run downloads ~1.6GB model from HuggingFace)"
echo ""
