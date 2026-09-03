#!/usr/bin/env bash
# Print whether this machine can run the dashboard and start agents.
# Exit 0 when bun, git, and tmux are present. Missing Claude is a warning.

set -euo pipefail

ok=0
warn=0
fail=0

have() { command -v "$1" >/dev/null 2>&1; }

check_ok() {
  printf '  ✓ %s\n' "$1"
  ok=$((ok + 1))
}

check_warn() {
  printf '  ! %s\n' "$1"
  warn=$((warn + 1))
}

check_fail() {
  printf '  ✗ %s\n' "$1"
  fail=$((fail + 1))
}

echo "AgentDock doctor"
echo ""

if have git; then
  check_ok "git $(git --version | awk '{print $3}')"
else
  check_fail "git — usually pre-installed; otherwise https://git-scm.com/"
fi

if have bun; then
  check_ok "bun $(bun --version)"
else
  check_fail "bun — ./setup.sh installs it, or: curl -fsSL https://bun.sh/install | bash"
fi

if have tmux; then
  check_ok "tmux $(tmux -V | awk '{print $2}')"
else
  check_fail "tmux — brew install tmux   or   sudo apt install tmux"
fi

if have claude; then
  check_ok "claude CLI"
  if [[ -f "${HOME}/.claude.json" ]] || [[ -d "${HOME}/.claude" ]]; then
    check_ok "Claude config present (run claude login if a session asks)"
  else
    check_warn "Claude is installed — run: claude login"
  fi
else
  check_warn "claude CLI — https://docs.anthropic.com/en/docs/claude-code then: claude login"
fi

if have agent; then
  check_ok "Cursor agent CLI"
else
  check_warn "Cursor agent CLI (optional) — https://docs.cursor.com/cli/agent"
fi

if ! have claude && ! have agent; then
  check_warn "install Claude or Cursor before starting a session"
fi

if have gh; then
  check_ok "gh $(gh --version | head -1 | awk '{print $3}')"
else
  check_warn "gh (optional) — brew install gh   for PR buttons"
fi

if echo "${PATH}" | tr ':' '\n' | grep -qx "${HOME}/bin"; then
  check_ok "~/bin is on PATH"
elif have agentdock; then
  check_ok "agentdock is on PATH"
else
  check_warn "add ~/bin to PATH:  export PATH=\"\$HOME/bin:\$PATH\""
fi

if [[ -f "${HOME}/.config/agentdock/repos.json" ]]; then
  check_ok "repos configured"
else
  check_warn "no repos yet — agentdock web opens a wizard on first launch"
fi

echo ""
if [[ "$fail" -gt 0 ]]; then
  echo "Missing ${fail} required tool(s). Install them, then run ./setup.sh again."
  exit 1
fi
if [[ "$warn" -gt 0 ]]; then
  echo "Dashboard can start. Fix the ${warn} warning(s) before launching agents."
  exit 0
fi
echo "Ready. Run:  agentdock web"
exit 0
