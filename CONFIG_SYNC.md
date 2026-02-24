# Configuration Sync Strategy

## Problem

When using both Claude Code and Cursor Agent, configuration files (rules, skills, instructions) can get out of sync, leading to:
- Different behavior between agents on the same repo
- Manual duplication of configuration
- Confusion about which agent sees which rules

## Solution: Unified Configuration with Sync

Both Claude and Cursor support similar configuration patterns:

| Aspect | Claude | Cursor |
|--------|--------|--------|
| **Global config** | `~/.claude/` | `~/.cursor/` |
| **Global skills** | `~/.codex/skills/` | `~/.cursor/skills-cursor/` |
| **Project rules file** | `CLAUDE.md` | `.cursorrules` |
| **Project rules dir** | `.claude/rules/` | `.cursor/rules/` |
| **Project skills** | `.claude/skills/` | `.cursor/skills/` |
| **Agent instructions** | `AGENTS.md` | `AGENTS.md` (same!) |

### Shared Conventions

Both agents understand:
- ✅ `AGENTS.md` - Project-specific agent instructions
- ✅ `.cursor/rules/` or `.claude/rules/` - Modular rules
- ✅ `.cursor/skills/` or `.claude/skills/` - Task-specific skills

## Recommended Strategy

### 1. Use Shared Files (Primary)

**For most cases, use files both agents can read:**

```bash
# Project structure (recommended)
my-repo/
  AGENTS.md                    # ✅ Both agents read this
  .cursorrules                 # ✅ Cursor reads this
  CLAUDE.md                    # ✅ Claude reads this (link to AGENTS.md)
  
  .cursor/
    rules/                     # ✅ Both can use modular rules
      backend.md
      testing.md
    skills/                    # ✅ Both support project skills
      deploy/SKILL.md
      
  .claude/
    skills/                    # Claude-specific skills (if needed)
      go-tester.md
```

**Best practice: Make CLAUDE.md a pointer to AGENTS.md**

```markdown
# CLAUDE.md
Read @AGENTS.md for all project-specific instructions.
```

### 2. Automated Sync Script

Create a sync script that keeps configurations in sync:

```bash
#!/usr/bin/env bash
# sync-agent-configs.sh
# Syncs configuration between Claude and Cursor

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Sync CLAUDE.md <-> .cursorrules
if [[ -f "$REPO_ROOT/CLAUDE.md" ]] && [[ ! -f "$REPO_ROOT/.cursorrules" ]]; then
  echo "Syncing CLAUDE.md -> .cursorrules"
  cp "$REPO_ROOT/CLAUDE.md" "$REPO_ROOT/.cursorrules"
fi

if [[ -f "$REPO_ROOT/.cursorrules" ]] && [[ ! -f "$REPO_ROOT/CLAUDE.md" ]]; then
  echo "Syncing .cursorrules -> CLAUDE.md"
  cp "$REPO_ROOT/.cursorrules" "$REPO_ROOT/CLAUDE.md"
fi

# Sync .cursor/rules/ <-> .claude/rules/
if [[ -d "$REPO_ROOT/.cursor/rules" ]]; then
  mkdir -p "$REPO_ROOT/.claude/rules"
  rsync -av --delete "$REPO_ROOT/.cursor/rules/" "$REPO_ROOT/.claude/rules/"
  echo "Synced .cursor/rules/ -> .claude/rules/"
fi

# Sync .cursor/skills/ <-> .claude/skills/
if [[ -d "$REPO_ROOT/.cursor/skills" ]]; then
  mkdir -p "$REPO_ROOT/.claude/skills"
  rsync -av --delete "$REPO_ROOT/.cursor/skills/" "$REPO_ROOT/.claude/skills/"
  echo "Synced .cursor/skills/ -> .claude/skills/"
fi

echo "✓ Configuration sync complete"
```

### 3. Git Hook Integration

Add a pre-commit hook to ensure configs stay in sync:

```bash
# .git/hooks/pre-commit
#!/usr/bin/env bash
./sync-agent-configs.sh
git add .cursorrules CLAUDE.md .cursor/ .claude/
```

### 4. AgentDock Integration

Add configuration sync features to agentdock:

**A. Session Launch Sync**
- Before launching any agent, auto-sync configurations
- Show warning if configs are out of sync
- Option to sync on session creation

**B. Config Health Check**
- Add to Settings > Health page
- Show which configs exist
- Show sync status
- One-click sync button

**C. Unified Config Editor**
- Single interface to edit rules/skills
- Automatically syncs to both agent formats
- Preview which agents will see which config

## Implementation Plan

### Phase 1: Detection & Reporting

Add to `server/src/services/config.ts`:

```typescript
export interface ConfigStatus {
  hasClaudeRules: boolean;
  hasCursorRules: boolean;
  hasClaude: boolean;
  hasCursor: boolean;
  hasAgentsMd: boolean;
  claudeSkills: string[];
  cursorSkills: string[];
  inSync: boolean;
  syncIssues: string[];
}

export function checkConfigSync(repoPath: string): ConfigStatus {
  // Check for CLAUDE.md, .cursorrules, AGENTS.md
  // Compare .cursor/rules/ vs .claude/rules/
  // Compare .cursor/skills/ vs .claude/skills/
  // Return sync status
}
```

### Phase 2: Auto-Sync on Launch

Update `session-manager.ts`:

```typescript
async function launchAgent(...) {
  // Before launching, sync configs
  if (shouldSyncConfigs) {
    await syncAgentConfigs(cwd);
  }
  // Then launch agent
}
```

### Phase 3: UI for Config Management

Add new page: `/config-sync`

Features:
- List all repos with config status
- Show which files exist for each agent
- Sync button per repo
- Global sync all button
- Preview config differences

### Phase 4: Smart Sync

Intelligent syncing based on timestamps:
- If CLAUDE.md newer → sync to .cursorrules
- If .cursorrules newer → sync to CLAUDE.md
- Detect conflicts and prompt user

## Quick Win: Universal AGENTS.md

**Immediate solution:** Use `AGENTS.md` as the single source of truth.

Both Claude and Cursor read `AGENTS.md`, so:

1. Move all shared instructions to `AGENTS.md`
2. Make `CLAUDE.md` and `.cursorrules` point to it:

```markdown
# CLAUDE.md
Read @AGENTS.md

# .cursorrules  
Read AGENTS.md for project conventions.
```

3. Put agent-specific details in their own files if needed

## Migration Steps

For your existing projects:

1. **Audit current configs:**
   ```bash
   # List all config files
   find /Users/vishal/projects -maxdepth 2 \( -name "CLAUDE.md" -o -name ".cursorrules" -o -name "AGENTS.md" \)
   ```

2. **Consolidate to AGENTS.md:**
   - Create/update `AGENTS.md` with shared instructions
   - Update `CLAUDE.md` to reference it
   - Create `.cursorrules` that references it

3. **Add sync script:**
   - Add `sync-agent-configs.sh` to agentdock
   - Run before each session launch

4. **Add to .gitignore (optional):**
   - If syncing automatically, consider only committing source files
   - `.claude/` could be gitignored if it's auto-generated from `.cursor/`

## Next Steps

Would you like me to:

1. **Create the sync script** - A bash script to sync configs
2. **Add it to session launch** - Auto-sync before launching agents
3. **Create a config health page** - UI to view and manage configs
4. **Migrate your existing repos** - Consolidate to AGENTS.md pattern

Let me know which approach you prefer!
