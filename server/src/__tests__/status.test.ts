/**
 * Tests for status.ts — terminal output pattern matching for agent status detection.
 *
 * Tests detectStatus() and extractStatusLine() with various terminal output patterns.
 * Note: detectStatus also checks Claude Code hooks via getHookStatus(), but we test
 * the pattern-matching fallback path here (hooks return null when no session name given).
 */

import { describe, test, expect } from "bun:test";
import { detectStatus, extractStatusLine } from "../services/status";

// Helper: call detectStatus without session name so hooks are skipped
function detect(content: string, command = "claude"): string {
  return detectStatus(content, 0, 0, command);
}

describe("detectStatus", () => {
  // ─── Shell detection ───

  test("returns 'shell' for bash command", () => {
    expect(detect("$ ls -la", "bash")).toBe("shell");
  });

  test("returns 'shell' for zsh command", () => {
    expect(detect("% echo hello", "zsh")).toBe("shell");
  });

  test("returns 'shell' for fish command", () => {
    expect(detect("prompt> pwd", "fish")).toBe("shell");
  });

  // ─── Unknown (empty content) ───

  test("returns 'unknown' for empty content", () => {
    expect(detect("")).toBe("unknown");
  });

  test("returns 'unknown' for whitespace-only content", () => {
    expect(detect("   \n  \n   ")).toBe("unknown");
  });

  // ─── Working indicators ───

  test("detects spinner characters as working", () => {
    expect(detect("Some context\n⠋ Loading...")).toBe("working");
    expect(detect("Some context\n⠸ Processing")).toBe("working");
    expect(detect("Some context\n◐ Thinking")).toBe("working");
  });

  test("detects Claude cooking animation as working", () => {
    // Pattern: single char + space + word + ellipsis (…)
    expect(detect("Some context\n✽ Flambeing…")).toBe("working");
    expect(detect("Some context\n✶ Baking…")).toBe("working");
  });

  test("detects Cursor working patterns", () => {
    expect(detect("Some context\nThinking...")).toBe("working");
    expect(detect("Some context\nWorking...")).toBe("working");
    expect(detect("Some context\nSearching...")).toBe("working");
    expect(detect("Some context\nReading...")).toBe("working");
    expect(detect("Some context\nEditing...")).toBe("working");
    expect(detect("Some context\nRunning...")).toBe("working");
  });

  // ─── Waiting (prompt) detection ───

  test("detects Claude prompt (❯) as waiting", () => {
    expect(detect("Previous output\n❯ ")).toBe("waiting");
    expect(detect("Previous output\n❯")).toBe("waiting");
  });

  test("detects Cursor prompt (>) as waiting", () => {
    expect(detect("Previous output\n> ")).toBe("waiting");
    expect(detect("Previous output\n>")).toBe("waiting");
  });

  test("detects Claude prompt with status bar below", () => {
    // Claude shows: prompt line, then status bar
    expect(detect("Some output\n❯ \n⏵⏵ accept edits on file.ts")).toBe("waiting");
  });

  test("detects background task running at prompt", () => {
    // Prompt visible but status bar shows (running) — background task
    expect(detect("Some output\n❯ \n⏵⏵ bypass permissions on · cd /Users/test/project … (running) · ↓ to manage")).toBe("background");
  });

  test("detects background task with prompt on previous line", () => {
    expect(detect("[STATUS: done | fixed thing]\n❯\n  ⏵⏵ accept edits on · task (running) · hold Space")).toBe("background");
  });

  test("prompt without (running) is still waiting", () => {
    expect(detect("Some output\n❯ \n⏵⏵ bypass permissions on · 0% until auto-compact")).toBe("waiting");
  });

  test("detects waiting when user is typing multi-line input", () => {
    // User is mid-input: prompt line has text, continuation lines below, status bar at bottom
    const content = [
      "[STATUS: input | what should I implement?]",
      "❯ Ok so this is what I need as part of moderation rule builder",
      "  - We support certain conditions e.g., text_rule, image_rule etc.",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    expect(detect(content)).toBe("waiting");
  });

  test("detects waiting when user typed a short input at prompt", () => {
    expect(detect("Previous output\n❯ hello world\n⏵⏵ bypass permissions on")).toBe("waiting");
  });

  test("detects Claude feedback prompt as waiting", () => {
    expect(detect("Done!\n● How is Claude doing this session?\n1: Bad  2: Fine  3: Good")).toBe("waiting");
  });

  test("detects feedback prompt rating lines as waiting", () => {
    expect(detect("Some output\n  1: Bad\n  2: Fine\n  3: Good\n  4: Dismiss")).toBe("waiting");
  });

  test("detects Claude plan mode UI as waiting", () => {
    expect(detect("Plan:\n❯ 1. Yes, clear context and start fresh")).toBe("waiting");
    expect(detect("Options:\n1. Yes, proceed\n2. No, cancel")).toBe("waiting");
    expect(detect("Edit plan\nctrl-g to edit in VS Code")).toBe("waiting");
  });

  // ─── Default to working ───

  test("defaults to 'working' when no prompt or spinner detected", () => {
    expect(detect("Processing files...\nUpdated 3 files")).toBe("working");
  });

  // ─── Divider lines are skipped ───

  test("skips divider lines when looking for tail", () => {
    // The prompt is above a long divider — should still detect it
    expect(detect("❯ \n────────────────────")).toBe("waiting");
  });

  // ─── ANSI escape codes ───

  test("strips ANSI escape codes before matching", () => {
    expect(detect("\x1b[32mSome output\x1b[0m\n\x1b[1m❯\x1b[0m ")).toBe("waiting");
    expect(detect("\x1b[33m⠋\x1b[0m Loading")).toBe("working");
  });
});

describe("extractStatusLine", () => {
  test("returns null when no status line present", () => {
    expect(extractStatusLine("just some regular output")).toBeNull();
  });

  test("extracts done status", () => {
    const result = extractStatusLine("output\n[STATUS: done | implemented login page]");
    expect(result).toEqual({ type: "done", message: "implemented login page" });
  });

  test("extracts input status", () => {
    const result = extractStatusLine("[STATUS: input | which database should I use?]");
    expect(result).toEqual({ type: "input", message: "which database should I use?" });
  });

  test("extracts error status", () => {
    const result = extractStatusLine("[STATUS: error | build failed, missing dep]");
    expect(result).toEqual({ type: "error", message: "build failed, missing dep" });
  });

  test("returns last status line when multiple present", () => {
    const content = `
      [STATUS: done | first thing]
      some more output
      [STATUS: error | second thing went wrong]
    `;
    const result = extractStatusLine(content);
    expect(result).toEqual({ type: "error", message: "second thing went wrong" });
  });

  test("handles ANSI codes in content", () => {
    const result = extractStatusLine("\x1b[32m[STATUS: done | deployed to staging]\x1b[0m");
    expect(result).toEqual({ type: "done", message: "deployed to staging" });
  });

  test("ignores malformed status lines", () => {
    expect(extractStatusLine("[STATUS: unknown | something]")).toBeNull();
    expect(extractStatusLine("[STATUS: done]")).toBeNull();
  });
});
