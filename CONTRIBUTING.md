# Contributing to agentdock

Thanks for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/vishalnarkhede/agentdock.git
cd agentdock
bun install
```

### Run in development mode

```bash
bun run dev
```

This starts both the server (port 4800) and client (port 5173) with hot reload.

### Project structure

- `server/` — Bun + Hono backend (TypeScript)
- `client/` — React + Vite frontend (TypeScript)
- `bin/` — CLI tools (bash scripts)

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Test locally with `bun run dev`
4. Submit a PR with a clear description of what changed and why

## Adding a New Agent

See [AGENTS.md](./AGENTS.md) for the step-by-step guide to adding support for a new AI coding agent.

## Code Style

- TypeScript for all server and client code
- No linter configured yet — match existing patterns
- Prefer simple, direct solutions over abstractions

## Issues

Use GitHub Issues for bug reports and feature requests.
