/**
 * Tests for session-manager.ts — pure functions for building agent commands
 * and parsing session targets.
 *
 * Only tests exported pure functions (no tmux/worktree interaction).
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, rmSync } from "fs";
import { buildAgentCmd, sessionNameFromTarget, parsePiece, writeSystemPromptFile } from "../services/session-manager";
import { PLANS_DIR_PATH } from "../services/config";

describe("buildAgentCmd", () => {
  // ─── Claude agent ───

  test("claude without skip permissions uses --allowedTools", () => {
    const cmd = buildAgentCmd("claude");
    expect(cmd).toStartWith("claude --allowedTools");
    expect(cmd).toContain("Read");
    expect(cmd).toContain("Edit");
    expect(cmd).toContain("Write");
    expect(cmd).toContain("Glob");
    expect(cmd).toContain("Grep");
    expect(cmd).toContain("'Bash(git:*)'");
  });

  test("claude with skip permissions uses --dangerously-skip-permissions", () => {
    const cmd = buildAgentCmd("claude", true);
    expect(cmd).toBe("claude --dangerously-skip-permissions");
  });

  test("claude with system prompt file appends flag", () => {
    const cmd = buildAgentCmd("claude", true, "/tmp/prompt.txt");
    expect(cmd).toContain("--append-system-prompt-file /tmp/prompt.txt");
  });

  test("claude with addDirs appends --add-dir flags", () => {
    const cmd = buildAgentCmd("claude", true, undefined, ["/repo/a", "/repo/b"]);
    expect(cmd).toContain("--add-dir /repo/a --add-dir /repo/b");
  });

  // ─── Cursor agent ───

  test("cursor without skip permissions returns 'agent'", () => {
    expect(buildAgentCmd("cursor")).toBe("agent");
  });

  test("cursor with skip permissions returns 'agent --yolo'", () => {
    expect(buildAgentCmd("cursor", true)).toBe("agent --yolo");
  });

  test("cursor ignores systemPromptFile and addDirs", () => {
    // Cursor CLI doesn't support these flags
    expect(buildAgentCmd("cursor", false, "/tmp/prompt.txt", ["/dir"])).toBe("agent");
  });

  // ─── Codex agent ───

  test("codex without skip permissions returns 'codex'", () => {
    expect(buildAgentCmd("codex")).toBe("codex");
  });

  test("codex with skip permissions bypasses approvals and sandbox", () => {
    expect(buildAgentCmd("codex", true)).toBe("codex --dangerously-bypass-approvals-and-sandbox");
  });

  test("codex includes add-dir and initial instruction prompt", () => {
    const cmd = buildAgentCmd("codex", false, "/tmp/sys prompt.txt", ["/repo/a", "/repo/b"]);
    expect(cmd).toContain('--add-dir "/repo/a" --add-dir "/repo/b"');
    expect(cmd).toContain("Read and follow the Agentdock session instructions in /tmp/sys prompt.txt");
  });
});

describe("sessionNameFromTarget", () => {
  test("prefixes with 'claude-'", () => {
    expect(sessionNameFromTarget("myrepo")).toBe("claude-myrepo");
  });

  test("replaces colons with hyphens", () => {
    expect(sessionNameFromTarget("repo:branch")).toBe("claude-repo-branch");
  });

  test("replaces slashes with hyphens", () => {
    expect(sessionNameFromTarget("org/repo")).toBe("claude-org-repo");
  });
});

describe("parsePiece", () => {
  test("parses alias only (no branch)", () => {
    const result = parsePiece("myrepo");
    expect(result).toEqual({ alias: "myrepo", branch: "" });
  });

  test("parses alias:branch", () => {
    const result = parsePiece("chat:main");
    expect(result).toEqual({ alias: "chat", branch: "main" });
  });

  test("handles multiple colons (first colon splits)", () => {
    const result = parsePiece("chat:branch:with:colons");
    expect(result).toEqual({ alias: "chat", branch: "branch:with:colons" });
  });

  test("handles empty string", () => {
    const result = parsePiece("");
    expect(result).toEqual({ alias: "", branch: "" });
  });
});

describe("writeSystemPromptFile", () => {
  // The agent is told where to write its plan. That path has to be the one
  // getPlan() reads, which follows AGENTDOCK_CONFIG_DIR — a second hardcoded
  // ~/.config path here means agents write where nothing looks for them.
  test("names the same plans dir config.ts resolves", () => {
    const sessionName = `claude-plans-path-${Date.now()}`;
    const file = writeSystemPromptFile(sessionName);
    try {
      const content = readFileSync(file, "utf-8");
      expect(content).toContain(PLANS_DIR_PATH);
      expect(content).not.toContain("{{PLANS_DIR}}");
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("plans dir tracks the isolated test config dir, not the real HOME", () => {
    expect(PLANS_DIR_PATH).toContain(process.env.AGENTDOCK_CONFIG_DIR!);
  });
});
