Read @AGENTS.md

## Project Mindset

This is an open-source project that other developers will install and use. Every change you make must work for anyone, not just the current developer's setup. Specifically:

- **No hardcoded paths** — never use `/Users/vishal/` or any absolute user-specific paths. Use `~`, `$HOME`, `process.env.HOME`, or relative paths.
- **No hardcoded ports** — respect `PORT` env vars and configurable defaults.
- **Features must be self-contained** — if a feature requires external setup (API keys, services, CLI tools), it should degrade gracefully when unavailable, not crash.
- **Think about first-run experience** — new users won't have existing sessions, MCP servers, or data. Empty states should be helpful, not broken.
- **Cross-platform awareness** — the primary target is macOS, but avoid macOS-only assumptions where possible (paths, commands).
- **No secrets in code** — never commit API keys, tokens, or credentials. Use environment variables.
- **Config belongs in `~/.config/agentdock/`** — not in the repo directory.

## Adding Jacek Quick Actions

Jacek is the project overseer panel (accessible via the "jacek" button in the header). It uses quick action buttons instead of free-form chat. When the user asks to "add a quick action to Jacek", follow these steps:

**File:** `client/src/components/JacekPanel.tsx`

Add an entry to the `QUICK_ACTIONS` array:
```typescript
const QUICK_ACTIONS = [
  // ... existing actions
  { label: "Button Label", message: "The instruction sent to Jacek's Claude session" },
];
```

- **`label`**: Short text shown on the button (keep under 20 chars)
- **`message`**: The full instruction sent to Jacek. Be specific about what data to fetch, how to format it, and what to include. Jacek has access to: `gh` CLI, agentdock MCP tools (`list_prs`, `list_sessions`, `get_session_output`, `send_message`, `check_messages`, `list_notes`, `add_note`), and bash.

**Jacek's prompt** is generated server-side at `server/src/routes/jacek.ts` in the `GET /api/jacek/prompt` endpoint. If the new action requires Jacek to have special instructions or know about new tools, update the prompt there.

**Jacek writes responses** to `/tmp/jacek-responses/response.md` as rich markdown. The panel renders this file with react-markdown. So the message should tell Jacek to format output nicely with headers, tables, bold, links etc.
