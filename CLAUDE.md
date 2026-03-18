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
