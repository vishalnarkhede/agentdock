#!/bin/sh
# Run the redesign clone alongside your normal AgentDock.
#
#   server  :4900        client  https://localhost:5273
#   config  ~/.config/agentdock-redesign   (isolated copy — cannot touch your real one)
#
# Ctrl+C stops both.

set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
export AGENTDOCK_CONFIG_DIR="$HOME/.config/agentdock-redesign"

for p in 4900 5273; do
  pid=$(lsof -ti:$p 2>/dev/null || true)
  [ -n "$pid" ] && { echo "port $p busy (pid $pid) — killing"; kill $pid 2>/dev/null || true; sleep 1; }
done

echo "server → http://localhost:4900"
( cd "$ROOT/server" && PORT=4900 bun run --watch src/index.ts ) &
SERVER_PID=$!

trap 'kill $SERVER_PID 2>/dev/null; exit 0' INT TERM

echo "client → https://localhost:5273   (self-signed cert, accept the warning)"
cd "$ROOT/client" && SERVER_PORT=4900 VITE_PORT=5273 npx vite

kill $SERVER_PID 2>/dev/null || true
