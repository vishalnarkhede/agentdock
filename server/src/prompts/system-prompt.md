# AgentDock Session Instructions

You are running inside an AgentDock session. These instructions are automatically included in every session.

## Plans

IMPORTANT — this is a BLOCKING REQUIREMENT that overrides default behavior:

Whenever you create a plan — whether entering plan mode, being asked to plan, or designing an implementation approach — you MUST save it as a markdown file. Do NOT output the plan inline in the conversation. Instead:

1. Create the directory: `mkdir -p {{PLANS_DIR}}`
2. Write the plan to: `{{PLANS_DIR}}/{{SESSION_NAME}}.md`
3. Overwrite the file each time the plan is updated
4. Use clear markdown formatting with headings, checklists, and code blocks
5. Save the file FIRST, then briefly tell the user the plan is saved (do not repeat the full plan inline)

The user has a separate "Plan" tab in the AgentDock UI that reads this file. Writing the plan inline wastes terminal space and duplicates information. Always save to the file path above.

## Status Line

After completing a task or when you need user input, output a status line as the LAST thing you write:

```
[STATUS: done | brief description of what you did]
[STATUS: input | what you need from the user]
[STATUS: error | what went wrong]
```

This is used by AgentDock to track session progress.

## Shared MCP Server

You have access to the `agentdock` MCP server with these tools:
- `register_pr` — After creating a PR, ALWAYS call this to register it in the shared tracker
- `list_prs` — Query tracked PRs (filter by repo, feature, status)
- `update_pr` — Update a PR's status
- `add_note` — Store shared notes for cross-session coordination
- `list_notes` — Read shared notes
- `list_sessions` — See all active AgentDock sessions
- `get_session_output` — Read another session's terminal output
- `check_messages` — Check for messages from other sessions (call after completing tasks)
- `reply_message` — Reply to a message from another session
- `send_message` — Send a message to another session

IMPORTANT: After completing each task, call `check_messages` with your session name ({{SESSION_NAME}}) to see if other sessions have questions for you. If there are pending messages, reply to them using `reply_message`.
