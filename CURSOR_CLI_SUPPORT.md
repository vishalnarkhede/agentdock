# Cursor CLI Support

This document describes the Cursor CLI integration in agentdock, enabling users to switch between Claude Code and Cursor Agent while maintaining conversation context.

## Overview

agentdock originally supported only Claude Code. This enhancement adds support for Cursor Agent, allowing users to:

1. **Choose agent type** when creating a new session (Claude or Cursor)
2. **View current agent** in the session list
3. **Switch agents** mid-conversation while preserving context

This is particularly useful when running out of tokens on one platform, or when you want to leverage different agent capabilities for different parts of a task.

## Architecture

### Type Definitions

```typescript
export type AgentType = "claude" | "cursor";

export interface SessionInfo {
  // ... existing fields ...
  agentType?: AgentType;
}

export interface CreateSessionRequest {
  // ... existing fields ...
  agentType?: AgentType;
}
```

### Backend Components

#### 1. Session Manager (`server/src/services/session-manager.ts`)

**Changes:**
- `launchAgent()` - Generalized from `launchClaude()` to support both agent types
- `buildAgentCmd()` - Generates the appropriate CLI command based on agent type
- Agent type is saved to a `.agent` metadata file for each session
- Context prompt formatting adjusted per agent (Claude vs Cursor expectations)

**Agent Command Generation:**
```typescript
function buildAgentCmd(agentType: AgentType, dangerouslySkipPermissions?: boolean): string {
  if (agentType === "cursor") {
    return "agent";  // Cursor CLI command
  }
  // Claude command with tool permissions
  if (dangerouslySkipPermissions) {
    return "claude --dangerously-skip-permissions";
  }
  const tools = ALLOWED_TOOLS.map((t) => t.includes("(") ? `'${t}'` : t).join(" ");
  return `claude --allowedTools ${tools}`;
}
```

#### 2. Config Service (`server/src/services/config.ts`)

**New Functions:**
- `getSessionAgentType(sessionName)` - Reads agent type from `.agent` file
- `saveSessionAgentType(sessionName, agentType)` - Saves agent type to `.agent` file
- `deleteSessionAgentType(sessionName)` - Cleans up agent metadata on session stop

**Storage Location:** `~/.config/agentdock/sessions/[session-name].agent`

#### 3. Sessions API (`server/src/routes/sessions.ts`)

**New Endpoint:**
```
POST /api/sessions/:name/switch-agent
Body: { agentType: "claude" | "cursor", contextMessage?: string }
```

**Switch Flow:**
1. Validate new agent type differs from current
2. Capture recent terminal context (last 20 lines)
3. Send Ctrl+C to stop current agent
4. Start new agent with appropriate command
5. Wait for agent to initialize (3s)
6. Send context prompt with conversation history
7. Update stored agent type metadata

**Updated Endpoint:**
- `GET /api/sessions` now includes `agentType` field in response

### Frontend Components

#### 1. Create Session Page (`client/src/pages/CreateSession.tsx`)

**UI Changes:**
- Added radio button selector for agent type (Claude / Cursor)
- Defaults to Claude for backward compatibility
- Agent type submitted with session creation request

**UI Screenshot (conceptual):**
```
Session Name: [___________]

Repositories: [Select repos...]

Agent Type:
  ( ) Claude Code    (●) Cursor Agent

[✓] Isolated worktrees
[✓] Skip permissions

[Launch]
```

#### 2. Dashboard (`client/src/pages/Dashboard.tsx`)

**Changes:**
- Session rows display agent type badge with emoji:
  - 🤖 Claude for Claude Code
  - 💻 Cursor for Cursor Agent
- Passes agent type to `TerminalView` component
- Refreshes session list after agent switch

#### 3. Terminal View (`client/src/components/TerminalView.tsx`)

**New Features:**
- Accepts `agentType` prop
- Displays "Switch Agent" button in toolbar (only when connected)
- Button shows target agent: "→ Cursor" or "→ Claude"
- Confirmation dialog before switching
- Disabled state while switching in progress
- Calls `onAgentSwitched` callback to trigger session refresh

**Toolbar Layout:**
```
[Connected] [copy] [iTerm] [🎤] [→ Cursor] [full]
```

#### 4. API Client (`client/src/api.ts`)

**New Function:**
```typescript
export async function switchAgent(
  sessionName: string,
  agentType: AgentType,
  contextMessage?: string
): Promise<{ ok: boolean; newAgentType: AgentType }>
```

### Styling (`client/src/styles.css`)

**New Classes:**
- `.agent-type-selector` - Container for radio buttons on create page
- `.radio-label` - Radio button label styling (hover, checked states)
- `.session-row-agent` - Agent type badge in session list

## Usage

### Creating a Session with Cursor

1. Navigate to "new session" page
2. Select repos (optional)
3. Choose "Cursor Agent" radio button
4. Click "Launch"

### Switching Agents Mid-Session

1. Open an active session
2. Click the "→ Cursor" (or "→ Claude") button in the terminal toolbar
3. Confirm the switch in the dialog
4. Wait 3-4 seconds for the new agent to initialize
5. The new agent receives recent context automatically

**Context Preservation:**
- Last 20 lines of terminal output are captured
- Sent as prompt to new agent: "Continuing from previous [agent] session. Recent context: ..."
- User can provide additional context in the confirmation dialog (future enhancement)

## Implementation Notes

### Agent Type Detection

The system detects which agent is currently running by:
1. Checking the `.agent` metadata file for the session
2. Falling back to "claude" if no metadata exists (backward compatibility)

### Context Transfer

When switching agents, the system:
1. Captures the last 20 lines of terminal output
2. Filters out ANSI escape codes (if needed)
3. Formats context prompt appropriately for target agent
4. Sends as initial message after agent starts

### Error Handling

- If switch fails, user sees error alert with message
- Original agent remains running if switch is cancelled
- Agent metadata is only updated after successful switch

### Backward Compatibility

- Existing sessions without agent metadata default to "claude"
- Agent type is optional in CreateSessionRequest (defaults to "claude")
- Sessions created before this update continue working normally

## Future Enhancements

### Potential Improvements

1. **Custom Context Messages**
   - Allow users to add custom instructions when switching
   - E.g., "Continue working on authentication, focus on error handling"

2. **Agent Capabilities Matrix**
   - Show which tools/features are available per agent
   - Help users choose appropriate agent for their task

3. **Auto-Switch on Token Limit**
   - Detect when Claude hits token limit
   - Prompt user to automatically switch to Cursor

4. **Session History Export**
   - Export full conversation history
   - Import into new session with different agent

5. **Multi-Agent Collaboration**
   - Run both agents simultaneously
   - Compare outputs or divide work

6. **Agent Performance Metrics**
   - Track success rate, speed, token usage per agent
   - Help users optimize agent selection

## Testing

### Manual Testing Checklist

- [ ] Create new session with Claude - verify it starts correctly
- [ ] Create new session with Cursor - verify it starts correctly
- [ ] Switch from Claude to Cursor - verify context is preserved
- [ ] Switch from Cursor to Claude - verify context is preserved
- [ ] View agent type badge in session list
- [ ] Verify agent metadata files are created
- [ ] Verify agent metadata files are cleaned up on session stop
- [ ] Test with isolated worktrees
- [ ] Test with multiple repos (grouped mode)
- [ ] Test cancel switch dialog - verify agent unchanged

### Known Limitations

1. **Cursor CLI Availability**
   - Requires Cursor CLI to be installed: `curl https://cursor.com/install -fsS | bash`
   - The `agent` command must be available in PATH
   - Should add to health check page

2. **Permission Model Differences**
   - Claude has `--allowedTools` permission system
   - Cursor agent may have different permission model
   - Commands may need adjustment based on actual Cursor CLI

3. **Prompt Format Differences**
   - Claude expects "Read and follow instructions in [file]"
   - Cursor may expect different format
   - Adjust based on actual Cursor CLI behavior

## Deployment

### Prerequisites

1. **Cursor CLI** must be installed:
   ```bash
   # macOS/Linux/WSL
   curl https://cursor.com/install -fsS | bash
   
   # Windows PowerShell
   irm 'https://cursor.com/install?win32=true' | iex
   ```
2. **Verify installation**: `agent --version`
3. **Update Health Check** - Add cursor CLI to health check page
4. **Documentation** - Update README with Cursor CLI setup instructions

### Migration

No database migration required. Agent metadata is stored in flat files.

Existing sessions will default to "claude" agent type automatically.

## Related Files

### Modified Files
- `server/src/services/session-manager.ts` - Core agent management logic
- `server/src/services/config.ts` - Agent metadata persistence
- `server/src/routes/sessions.ts` - Switch agent endpoint
- `server/src/types.ts` - Type definitions
- `client/src/pages/CreateSession.tsx` - Agent type selector UI
- `client/src/pages/Dashboard.tsx` - Agent type display
- `client/src/components/TerminalView.tsx` - Switch agent button
- `client/src/api.ts` - API client function
- `client/src/types.ts` - Frontend type definitions
- `client/src/styles.css` - Styling

### Created Files
- `CURSOR_CLI_SUPPORT.md` - This document

---

## Questions or Issues?

If you encounter any issues with Cursor CLI support:

1. **Install Cursor CLI**: `curl https://cursor.com/install -fsS | bash`
2. **Verify installation**: `agent --version`
3. Check that `agent` command is available in your PATH
4. Review terminal output for agent startup errors
5. Check `~/.config/agentdock/sessions/[session-name].agent` for correct agent type
6. Check server logs for API errors during switch

For feature requests or bugs, please file an issue in the repository.
