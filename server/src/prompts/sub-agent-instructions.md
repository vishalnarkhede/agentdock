# Sub-Agent Orchestration

You have access to `ad-agent`, a CLI tool for spawning and managing sub-agents. Sub-agents are independent AI agent sessions that run in parallel, each in their own terminal. Use them to delegate work and parallelize tasks.

## When to use sub-agents

- The task spans multiple repositories
- The task has independent, parallelizable sub-tasks
- The task is too large for a single agent to handle efficiently
- You need to run long tasks without blocking yourself

## Available commands

### Spawn a sub-agent
```bash
ad-agent spawn --repo <alias> --prompt "task description"
```
Options:
- `--repo <alias>` (required) — repo alias (e.g. `chat`, `django`, `js-sdk`)
- `--prompt "..."` (required) — task description for the sub-agent
- `--agent-type claude|cursor` — which agent CLI to use (default: claude)
- `--skip-perms` — run with full permissions (--dangerously-skip-permissions / --yolo)
- `--name <name>` — custom session name

Returns the session name of the created sub-agent.

### Check sub-agent status
```bash
ad-agent status <session-name>
```
Returns: `waiting` (idle, task complete), `working` (busy), `shell` (at shell), `unknown`, or `not_found`.

### Read sub-agent output
```bash
ad-agent output <session-name> [--lines 100]
```
Returns the last N lines of the sub-agent's terminal output, plus any `[STATUS: ...]` line.

### Wait for sub-agent to finish
```bash
ad-agent wait <session-name> [--timeout 300] [--poll 5]
```
Blocks until the sub-agent reaches `waiting` status or times out. Returns: `done`, `shell`, or `timeout`.

### Send input to sub-agent
```bash
ad-agent send <session-name> --text "your message"
```
Sends text input to the sub-agent (as if you typed it).

### List sub-agents
```bash
ad-agent list
```
Shows all your child sub-agents with their status.

### Stop a sub-agent
```bash
ad-agent kill <session-name>
```

## Workflow pattern

Here's the recommended pattern for using sub-agents:

```bash
# 1. Spawn sub-agents for parallel tasks
AGENT1=$(ad-agent spawn --repo chat --prompt "Add rate limiting to the messages endpoint" --skip-perms)
AGENT2=$(ad-agent spawn --repo django --prompt "Add the rate_limit config field to Organization model" --skip-perms)

# 2. Wait for them to finish
ad-agent wait $AGENT1 --timeout 600
ad-agent wait $AGENT2 --timeout 600

# 3. Check results
ad-agent output $AGENT1 --lines 50
ad-agent output $AGENT2 --lines 50

# 4. Clean up
ad-agent kill $AGENT1
ad-agent kill $AGENT2
```

## Important notes

- Each sub-agent runs in its own tmux session with full agent capabilities
- Sub-agents inherit the same agent type (Claude/Cursor) unless overridden
- Sub-agents are automatically cleaned up when the parent session is stopped
- Use `ad-agent list` to see all your active sub-agents at any time
- The `[STATUS: done | description]` convention works in sub-agents too — check their output for it
- If a sub-agent seems stuck, read its output first before killing it
- Keep prompts clear and specific — sub-agents work best with focused, well-defined tasks
