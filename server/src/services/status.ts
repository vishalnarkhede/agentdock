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

  // ── Primary: Claude Code hooks (deterministic, source of truth) ──
  // 5 hooks keep status accurate:
  //   PreToolUse       → "working"  (tool call — fires frequently during active work)
  //   UserPromptSubmit → "working"  (user sent input)
  //   SubagentStop     → "working"  (sub-agent done, parent still active)
  //   Stop             → "waiting"  (Claude finished responding)
  //   Notification     → "waiting"  (idle at prompt)
  //
  // PreToolUse is the key: it fires on every tool call (Read, Edit, Bash, Agent, etc.)
  // including by sub-agents, keeping "working" fresh. Terminal scanning is only a
  // fallback for non-Claude agents (Cursor) or before hooks report.
  if (sessionName) {
    const hookStatus = getHookStatus(sessionName);
    if (hookStatus === "waiting") {
      // Refine: check if there's a background task running in the status bar
      const rawLines = content.split("\n");
      for (let i = rawLines.length - 1; i >= Math.max(0, rawLines.length - 5); i--) {
        if (/\(running\)/.test(stripAnsi(rawLines[i]))) return "background";
      }
      return "waiting";
    }
    if (hookStatus) return hookStatus;
  }

  // ── Fallback: terminal pattern matching (Cursor Agent, or pre-hook) ──

  const lines = content.split("\n");
  const tail: string[] = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < 5; i--) {
    const clean = stripAnsi(lines[i]).trim();
    if (clean && !isDivider(clean)) tail.unshift(clean);
  }

  if (tail.length === 0) return "unknown";

  // Working indicators (Cursor Agent patterns)
  if (tail.some((line) =>
    /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓]/.test(line) ||
    /^(Thinking|Working|Searching|Reading|Editing|Running)\.\.\./i.test(line)
  )) {
    return "working";
  }

  // Prompt detection
  const isClaudePrompt = (line: string) => /^❯/.test(line);
  const isCursorPrompt = (line: string) => /^>\s*$/.test(line) || /^> /.test(line);
  const isPromptLine = (line: string) => isClaudePrompt(line) || isCursorPrompt(line);
  const isPromptUI = (line: string) => /accept edits|shift.tab|⏵⏵|auto-compact|hold Space/.test(line);
  const hasBackgroundTask = (line: string) => /\(running\)/.test(line);
  const isFeedbackPrompt = (line: string) => /how is claude doing/i.test(line) || /^\s*[0-9]+:\s*(Bad|Fine|Good|Dismiss)/i.test(line);
  const isPlanModeUI = (line: string) => /^❯\s+\d+\.\s/.test(line) || /^\d+\.\s+(Yes|No|Type here)/i.test(line) || /ctrl-g to edit/i.test(line);
  const lastLine = tail[tail.length - 1];

  if (isPromptLine(lastLine) && tail.some(hasBackgroundTask)) {
    return "background";
  }

  if (isPromptUI(lastLine) && tail.some(isClaudePrompt)) {
    if (tail.some(hasBackgroundTask)) return "background";
    return "waiting";
  }

  if (isPromptLine(lastLine)) {
    return "waiting";
  }

  if (tail.some(isFeedbackPrompt)) {
    return "waiting";
  }

  if (tail.some(isPlanModeUI)) {
    return "waiting";
  }

  return "working";
}
