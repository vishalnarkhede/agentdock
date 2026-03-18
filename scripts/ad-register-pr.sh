#!/bin/bash
# Register a PR in the shared tracker
# Usage: ad-register-pr.sh <repo> <url> [title] [feature] [session-name]
curl -s -X POST http://localhost:4800/mcp \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"register_pr\",\"arguments\":{\"repo\":\"$1\",\"url\":\"$2\",\"title\":\"${3:-}\",\"feature\":\"${4:-}\",\"session_name\":\"${5:-}\"}}}"
