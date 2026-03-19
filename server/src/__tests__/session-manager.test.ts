/**
 * Tests for session-manager.ts — pure functions for building agent commands
 * and parsing session targets.
 *
 * Only tests exported pure functions (no tmux/worktree interaction).
 */

import { describe, test, expect } from "bun:test";
import { buildAgentCmd, sessionNameFromTarget, parsePiece } from "../services/session-manager";

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

  test("claude with all options combined", () => {
    const cmd = buildAgentCmd("claude", true, "/tmp/sys.txt", ["/dir/x"]);
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).toContain("--append-system-prompt-file /tmp/sys.txt");
    expect(cmd).toContain("--add-dir /dir/x");
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

  test("handles complex target strings", () => {
    expect(sessionNameFromTarget("chat:feature/login")).toBe("claude-chat-feature-login");
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

  test("handles branch with slashes", () => {
    const result = parsePiece("chat:feature/login-page");
    expect(result).toEqual({ alias: "chat", branch: "feature/login-page" });
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
