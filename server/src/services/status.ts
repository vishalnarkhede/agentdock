/**
 * Detect agent session status.
 *
 * Primary: Claude Code hooks (Stop, Notification, UserPromptSubmit) write status
 * to /tmp/agentdock-status/<session>. This is deterministic and reliable.
 *
 * Fallback: Terminal output pattern matching for Cursor Agent or when hooks
 * haven't reported yet. This is inherently fragile but covers non-Claude agents.
 */

import { getHookStatus } from "./config";

export type SessionStatus = "waiting" | "working" | "background" | "shell" | "unknown";

const SHELLS = new Set(["bash", "zsh", "fish", "sh"]);

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

function isDivider(line: string): boolean {
  return /^[─━\-=╌╍┄┅┈┉]+$/.test(line) && line.length > 10;
}

/**
 * Extract the last [STATUS: ...] line from terminal content.
 * Format: [STATUS: done | brief description]
 *         [STATUS: input | what you need]
 *         [STATUS: error | what went wrong]
 *
 * Works for both Claude and Cursor agents (agent-agnostic format).
 */
export function extractStatusLine(content: string): { type: string; message: string } | null {
  const clean = stripAnsi(content);
  // Search from the end for the last [STATUS: ...] line
  const matches = clean.match(/\[STATUS:\s*(done|input|error)\s*\|\s*([^\]]+)\]/g);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const parsed = last.match(/\[STATUS:\s*(done|input|error)\s*\|\s*([^\]]+)\]/);
  if (!parsed) return null;
  return { type: parsed[1].trim(), message: parsed[2].trim() };
}

export function detectStatus(content: string, _cursorY: number, _scrollPosition: number, command: string, sessionName?: string): SessionStatus {
  if (SHELLS.has(command)) {
    return "shell";
  }

  // Primary: use Claude Code hook-reported status (deterministic)
  // But still check terminal for background tasks — hooks don't distinguish idle vs background
  if (sessionName) {
    const hookStatus = getHookStatus(sessionName);
    if (hookStatus === "waiting") {
      // Check if there's a background task running in the status bar
      const rawLines = content.split("\n");
      for (let i = rawLines.length - 1; i >= Math.max(0, rawLines.length - 5); i--) {
        if (/\(running\)/.test(stripAnsi(rawLines[i]))) return "background";
      }
      return "waiting";
    }
    if (hookStatus) return hookStatus;
  }

  const lines = content.split("\n");

  // Collect last 5 non-empty, non-divider lines (bottom up, stored in order)
  const tail: string[] = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < 5; i--) {
    const clean = stripAnsi(lines[i]).trim();
    if (clean && !isDivider(clean)) tail.unshift(clean);
  }

  if (tail.length === 0) return "unknown";

  // Working indicators (both agents):
  // - Spinners: ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓
  // - Claude cooking animation: ✽ Flambéing… ✶ Baking… (char + space + word + …)
  // - Cursor working: "Thinking...", "Working...", spinner chars, or progress indicators
  if (tail.some((line) =>
    /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓]/.test(line) ||
    /^\S\s+\S+…/.test(line) ||
    /^(Thinking|Working|Searching|Reading|Editing|Running)\.\.\./i.test(line)
  )) {
    return "working";
  }

  // Prompt detection for both agents:
  //
  // Claude Code:
  //   tail[-2]: ❯ (prompt)
  //   tail[-1]: ⏵⏵ accept edits on ... (status bar)
  //
  // Cursor Agent CLI:
  //   tail[-1]: > (prompt, or "> " with cursor)
  const isClaudePrompt = (line: string) => /^❯/.test(line);
  const isCursorPrompt = (line: string) => /^>\s*$/.test(line) || /^> /.test(line);
  const isPromptLine = (line: string) => isClaudePrompt(line) || isCursorPrompt(line);
  const isPromptUI = (line: string) => /accept edits|shift.tab|⏵⏵|auto-compact|hold Space/.test(line);
  // Claude Code status bar with background task: "⏵⏵ ... (running) ..."
  const hasBackgroundTask = (line: string) => /\(running\)/.test(line);
  // Claude Code feedback prompt: "● How is Claude doing this session?"
  const isFeedbackPrompt = (line: string) => /how is claude doing/i.test(line) || /^\s*[0-9]+:\s*(Bad|Fine|Good|Dismiss)/i.test(line);
  // Claude Code plan mode selection: "❯ 1. Yes, clear context..." or "ctrl-g to edit in VS Code"
  const isPlanModeUI = (line: string) => /^❯\s+\d+\.\s/.test(line) || /^\d+\.\s+(Yes|No|Type here)/i.test(line) || /ctrl-g to edit/i.test(line);
  const lastLine = tail[tail.length - 1];

  // Check for prompt with background task running — agent is idle but has background work
  if (isPromptLine(lastLine) && tail.some(hasBackgroundTask)) {
    return "background";
  }

  // Status bar is last line (⏵⏵ ...) — prompt may be further up due to multi-line user input
  if (isPromptUI(lastLine) && tail.some(isClaudePrompt)) {
    if (tail.some(hasBackgroundTask)) return "background";
    return "waiting";
  }

  if (isPromptLine(lastLine)) {
    return "waiting";
  }

  // Claude Code shows a feedback prompt after completing work — agent is idle
  if (tail.some(isFeedbackPrompt)) {
    return "waiting";
  }

  // Claude Code plan mode: shows numbered options for how to proceed
  if (tail.some(isPlanModeUI)) {
    return "waiting";
  }

  return "working";
}
