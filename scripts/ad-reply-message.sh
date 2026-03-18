#!/bin/bash
# Reply to a message by ID
# Usage: ad-reply-message.sh <message-id> <reply-text>
curl -s -X POST http://localhost:4800/mcp \
  -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"reply_message\",\"arguments\":{\"message_id\":$1,\"reply\":\"$2\"}}}"
