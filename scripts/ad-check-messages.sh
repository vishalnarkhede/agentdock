#!/bin/bash
# Check for pending messages for a session
# Usage: ad-check-messages.sh <session-name>
curl -s -X POST http://localhost:4800/mcp \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"check_messages\",\"arguments\":{\"session_name\":\"$1\"}}}"
