import { existsSync, readFileSync, writeFileSync, copyFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/**
 * Config sync strategy:
 *
 * Source of truth: ~/.claude/CLAUDE.md (global) + repo AGENTS.md (per-repo)
 *
 * Claude reads:
 *   - ~/.claude/CLAUDE.md (global, automatic)
 *   - CLAUDE.md in repo root (if exists, references @AGENTS.md)
 *
 * Cursor Agent CLI reads:
 *   - AGENTS.md in repo root
 *   - .cursor/rules/ directory
 *   - Does NOT read ~/.cursorrules (legacy, deprecated)
 *
 * Sync logic:
 *   1. Global instructions from ~/.claude/CLAUDE.md get injected into
 *      each repo's AGENTS.md under a marked section
 *   2. CLAUDE.md in the repo references @AGENTS.md so Claude reads it too
 *   3. This runs automatically before every agent launch
 */

const GLOBAL_START = "<!-- GLOBAL_INSTRUCTIONS_START -->";
const GLOBAL_END = "<!-- GLOBAL_INSTRUCTIONS_END -->";

export interface SyncResult {
  synced: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Reads global instructions from ~/.claude/CLAUDE.md
 */
function getGlobalInstructions(): string | null {
  const globalPath = join(homedir(), ".claude", "CLAUDE.md");
  if (!existsSync(globalPath)) return null;
  return readFileSync(globalPath, "utf-8").trim();
}

/**
 * Wraps global instructions in markers so we can update them later
 */
function wrapGlobalSection(content: string): string {
  return `${GLOBAL_START}\n${content}\n${GLOBAL_END}`;
}

/**
 * Replaces or prepends the global section in AGENTS.md content
 */
function mergeGlobalIntoAgents(existingContent: string, globalContent: string): string {
  const wrapped = wrapGlobalSection(globalContent);

  // If markers already exist, replace the section
  const startIdx = existingContent.indexOf(GLOBAL_START);
  const endIdx = existingContent.indexOf(GLOBAL_END);

  if (startIdx !== -1 && endIdx !== -1) {
    const before = existingContent.slice(0, startIdx).trimEnd();
    const after = existingContent.slice(endIdx + GLOBAL_END.length).trimStart();
    const parts = [wrapped];
    if (after) parts.push(after);
    if (before) parts.unshift(before);
    return parts.join("\n\n");
  }

  // No markers - prepend global section before existing content
  return `${wrapped}\n\n${existingContent}`;
}

/**
 * Checks if the global section in AGENTS.md is up-to-date
 */
function isGlobalSectionCurrent(agentsContent: string, globalContent: string): boolean {
  const startIdx = agentsContent.indexOf(GLOBAL_START);
  const endIdx = agentsContent.indexOf(GLOBAL_END);

  if (startIdx === -1 || endIdx === -1) return false;

  const currentGlobal = agentsContent
    .slice(startIdx + GLOBAL_START.length, endIdx)
    .trim();

  return currentGlobal === globalContent.trim();
}

/**
 * Syncs configuration for a specific repository path.
 * - Injects global instructions from ~/.claude/CLAUDE.md into repo's AGENTS.md
 * - Ensures CLAUDE.md in repo references @AGENTS.md
 */
export async function syncRepoConfig(repoPath: string): Promise<SyncResult> {
  const result: SyncResult = {
    synced: [],
    skipped: [],
    errors: [],
  };

  try {
    const globalInstructions = getGlobalInstructions();
    const agentsMd = join(repoPath, "AGENTS.md");
    const claudeMd = join(repoPath, "CLAUDE.md");

    // --- Sync global instructions into AGENTS.md ---
    if (globalInstructions) {
      if (existsSync(agentsMd)) {
        const existing = readFileSync(agentsMd, "utf-8");

        if (isGlobalSectionCurrent(existing, globalInstructions)) {
          result.skipped.push("AGENTS.md global section is current");
        } else {
          const merged = mergeGlobalIntoAgents(existing, globalInstructions);
          writeFileSync(agentsMd, merged);
          result.synced.push("AGENTS.md updated with global instructions");
        }
      } else {
        // No AGENTS.md exists - create one with just global instructions
        writeFileSync(agentsMd, wrapGlobalSection(globalInstructions) + "\n");
        result.synced.push("AGENTS.md created with global instructions");
      }
    } else {
      result.skipped.push("No ~/.claude/CLAUDE.md found");
    }

    // --- Ensure CLAUDE.md references AGENTS.md ---
    if (existsSync(agentsMd)) {
      if (!existsSync(claudeMd)) {
        writeFileSync(claudeMd, "Read @AGENTS.md\n");
        result.synced.push("CLAUDE.md created → @AGENTS.md");
      } else {
        const claudeContent = readFileSync(claudeMd, "utf-8");
        if (!claudeContent.includes("AGENTS.md") && !claudeContent.includes("@AGENTS.md")) {
          writeFileSync(claudeMd, "Read @AGENTS.md\n\n" + claudeContent);
          result.synced.push("CLAUDE.md updated → @AGENTS.md");
        } else {
          result.skipped.push("CLAUDE.md already references AGENTS.md");
        }
      }
    }
  } catch (err: any) {
    result.errors.push(err.message);
  }

  return result;
}

/**
 * Get sync status without performing sync
 */
export function getConfigSyncStatus(repoPath: string): {
  hasAgentsMd: boolean;
  hasClaudeMd: boolean;
  hasGlobalInstructions: boolean;
  globalSectionCurrent: boolean;
  claudeReferencesAgents: boolean;
  needsSync: boolean;
} {
  const agentsMd = join(repoPath, "AGENTS.md");
  const claudeMd = join(repoPath, "CLAUDE.md");

  const hasAgentsMd = existsSync(agentsMd);
  const hasClaudeMd = existsSync(claudeMd);

  const globalInstructions = getGlobalInstructions();
  const hasGlobalInstructions = !!globalInstructions;

  let globalSectionCurrent = false;
  if (hasAgentsMd && globalInstructions) {
    const content = readFileSync(agentsMd, "utf-8");
    globalSectionCurrent = isGlobalSectionCurrent(content, globalInstructions);
  }

  let claudeReferencesAgents = false;
  if (hasClaudeMd) {
    const content = readFileSync(claudeMd, "utf-8");
    claudeReferencesAgents = content.includes("AGENTS.md") || content.includes("@AGENTS.md");
  }

  const needsSync =
    (hasGlobalInstructions && !globalSectionCurrent) ||
    (hasAgentsMd && hasClaudeMd && !claudeReferencesAgents);

  return {
    hasAgentsMd,
    hasClaudeMd,
    hasGlobalInstructions,
    globalSectionCurrent,
    claudeReferencesAgents,
    needsSync,
  };
}
