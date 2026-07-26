/**
 * Detect agent session status.
 *
 * Primary: Claude Code hooks (Stop, Notification, UserPromptSubmit) write status
 * to /tmp/agentdock-status/<session>. This is deterministic and reliable.
 *
 * Fallback: Terminal output pattern matching for Cursor Agent or when hooks
 * haven't reported yet. This is inherently fragile but covers non-Claude agents.
 */

import { getHookStatusInfo } from "./config";

export type SessionStatus = "waiting" | "working" | "background" | "shell" | "unknown";

const SHELLS = new Set(["bash", "zsh", "fish", "sh"]);
const STATUS_LINE_RE = /\[STATUS:\s*(done|input|error)\s*\|\s*([^\]]+)\]/;
const FRESH_WORKING_HOOK_GRACE_SECONDS = 30;

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

function isDivider(line: string): boolean {
  return /^[─━\-=╌╍┄┅┈┉]+$/.test(line) && line.length > 10;
}

function meaningfulTail(content: string, limit: number): string[] {
  const clean = stripAnsi(content);
  const lines = clean
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !isDivider(line));
  return lines.slice(-limit);
}

function parseStatusLine(line: string): { type: string; message: string } | null {
  const parsed = line.match(STATUS_LINE_RE);
  if (!parsed) return null;
  return { type: parsed[1].trim(), message: parsed[2].replace(/\s+/g, " ").trim() };
}

function parseStatusAt(lines: string[], index: number): { parsed: { type: string; message: string }; endIndex: number } | null {
  if (!lines[index]?.includes("[STATUS:")) return null;

  let joined = "";
  const maxEnd = Math.min(lines.length, index + 6);
  for (let i = index; i < maxEnd; i++) {
    joined = joined ? `${joined} ${lines[i]}` : lines[i];
    if (!lines[i].includes("]")) continue;

    const parsed = parseStatusLine(joined);
    return parsed ? { parsed, endIndex: i } : null;
  }

  return null;
}

function isAgentPrompt(line: string): boolean {
  return /^❯(?:\s|$)/.test(line) || /^>(?:\s|$)/.test(line) || /^›(?:\s|$)/.test(line) || /^codex>(?:\s|$)/i.test(line);
}

function isAgentStatusBar(line: string): boolean {
  return /^⏵⏵/.test(line) || /\b(bypass permissions|accept edits|esc to interrupt|shift\+tab to cycle|auto-compact)\b/i.test(line);
}

function isWorkingIndicatorLine(line: string): boolean {
  const trimmed = line.trim();
  return /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓]/.test(trimmed)
    // "· Beaming… (38s · ↓ 2.5k tokens)", "* Twisting…". Shape, not vocabulary:
    // the verb comes from a large set Claude keeps extending, so an unmatched one
    // used to read as "not working" — the same whitelist trap as the completion
    // footer. The trailing ellipsis is the stable part; "Sautéed for 1m 28s" has
    // none, so completion footers still do not match here.
    || /^[·*✻✢✳✶◐◑◒◓⏺]?\s*\p{Lu}\p{L}*(?:\.\.\.|…)/u.test(trimmed)
    || /^(?:[✻✢✳✶]\s*)?Considering(?:\.\.\.|…|\b)/i.test(trimmed);
}

function isActiveAgentTitle(title: string): boolean {
  const clean = stripAnsi(title).trim();
  return /^[\u2801-\u28ff◐◑◒◓✢✳✶]\s+\S/u.test(clean);
}

// "✻ Sautéed for 1m 28s". Matched by shape, not by verb: Claude picks the word
// from a large and growing set, and a whitelist that misses one throws away the
// completion status that follows it.
function isClaudeCompletionSummary(line: string): boolean {
  return /^(?:[✻✢✳✶]\s*)?\p{Lu}\p{L}* for \d+[smh]\b/u.test(line);
}

function isClaudeTitleBar(line: string): boolean {
  return /^[─━\-=╌╍┄┅┈┉]+\s*\S.*[─━\-=╌╍┄┅┈┉]+$/.test(line);
}

// Claude renders tool results, tips and classifier notes as "⎿ …" continuations
// of the message that just ended. They trail the final [STATUS: …] line without
// meaning the agent picked work back up — treat them as passive, or the
// completion status is discarded and the agent reads as still working.
function isClaudeContinuationLine(line: string): boolean {
  return /^⎿/.test(line.trim());
}

function isPassiveStatusFollower(line: string): boolean {
  return isAgentPrompt(line)
    || isAgentStatusBar(line)
    || isClaudeCompletionSummary(line)
    || isClaudeTitleBar(line)
    || isClaudeContinuationLine(line);
}

// Whether anything after a [STATUS: …] line shows the agent picked work back up.
// Only consulted for the wrapped tail of a "⎿ …" block, where the text is bare
// prose that no chrome pattern can match.
function indicatesNewActivity(line: string): boolean {
  const trimmed = line.trim();
  return /^●/.test(trimmed)             // a new assistant message or tool call
    || isWorkingIndicatorLine(trimmed); // a live spinner / "Thinking…"
}

// A completion status survives only if everything after it is chrome.
//
// Stateful because "⎿ …" blocks wrap: a tip long enough to run onto a second
// line continues as bare prose, which no chrome pattern matches, and treating
// that as new output threw the completion status away and left the agent
// showing as working. Inside a wrapped block, anything short of real activity
// still counts as quiet.
//
// Only used for output we cannot identify as an agent TUI — see
// statusSupersededByNewTurn for why enumerating chrome is a losing game.
function followersAreQuiet(following: string[]): boolean {
  let inWrappedBlock = false;
  for (const line of following) {
    if (isPassiveStatusFollower(line)) {
      inWrappedBlock = isClaudeContinuationLine(line);
      continue;
    }
    if (inWrappedBlock && !indicatesNewActivity(line)) continue;
    return false;
  }
  return true;
}

function isPromptWithText(line: string): boolean {
  return /^[❯>›]\s+\S/.test(line.trim()) || /^codex>\s+\S/i.test(line.trim());
}

// Whether we can recognise the output as an agent's full-screen TUI. When we
// can, unrecognised lines are chrome we have not caught up with; when we cannot,
// they are ordinary output and must invalidate a stale status line.
function looksLikeAgentTui(tail: string[]): boolean {
  return tail.some((line) =>
    /^●/.test(line.trim()) || isAgentStatusBar(line) || isAgentPrompt(line));
}

// Whether a new turn began after the [STATUS: …] line at `endIndex`.
//
// Asks what *started* rather than what is allowed to follow. Listing every
// benign line an agent can print between its status line and the input box is
// unwinnable — the vocabulary grows with each release, and each addition
// ("Sautéed for 1m", "※ recap:", a wrapped "⎿ Tip:") silently discarded the
// completion status and pinned finished agents to "working". The markers that
// open a new turn are far fewer and structural:
//
//   ●          an assistant message or tool call
//   spinner    work actively in progress
//   ❯ <text>   a submitted prompt — but NOT the input box, which always renders
//              last, so only a prompt above the final one counts as submitted
//
// Anything else after the status line is chrome, known or not.
function statusSupersededByNewTurn(tail: string[], endIndex: number): boolean {
  let lastPromptIndex = -1;
  for (let i = 0; i < tail.length; i++) {
    if (isAgentPrompt(tail[i])) lastPromptIndex = i;
  }

  for (let i = endIndex + 1; i < tail.length; i++) {
    const line = tail[i];
    if (/^●/.test(line.trim())) return true;
    if (isWorkingIndicatorLine(line)) return true;
    if (isPromptWithText(line) && i !== lastPromptIndex) return true;
  }
  return false;
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
  const lines = clean
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !isDivider(line));

  let last: { type: string; message: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const status = parseStatusAt(lines, i);
    if (!status) continue;
    last = status.parsed;
    i = status.endIndex;
  }
  return last;
}

export function extractRecentStatusLine(content: string, maxTailLines = 12): { type: string; message: string } | null {
  const tail = meaningfulTail(content, maxTailLines);
  for (let i = tail.length - 1; i >= 0; i--) {
    const status = parseStatusAt(tail, i);
    if (!status) continue;
    const stillCurrent = looksLikeAgentTui(tail)
      ? !statusSupersededByNewTurn(tail, status.endIndex)
      : followersAreQuiet(tail.slice(status.endIndex + 1));
    return stillCurrent ? status.parsed : null;
  }
  return null;
}

export function displayStatusLine(content: string, status: SessionStatus | "stopped"): { type: string; message: string } | null {
  const statusLine = extractRecentStatusLine(content, 30);
  if (status === "working" || status === "background" || status === "shell") {
    return statusLine?.type === "done" || statusLine?.type === "error" ? statusLine : null;
  }
  return statusLine;
}

export function detectStatus(
  content: string,
  _cursorY: number,
  _scrollPosition: number,
  command: string,
  sessionName?: string,
  paneTitle = "",
): SessionStatus {
  const tail = meaningfulTail(content, 8);

  const statusLine = extractRecentStatusLine(content, 30);
  const hasExplicitInputStatus = statusLine?.type === "input";
  const hasCompletionStatus = statusLine?.type === "done" || statusLine?.type === "error";
  const hasActiveBackgroundTask = tail.some((line) => /\(running\)/.test(line));
  const hasWorkingIndicator = tail.some(isWorkingIndicatorLine);
  const hasActiveTitle = isActiveAgentTitle(paneTitle);
  const isClaudePrompt = (line: string) => /^❯/.test(line);
  const isCursorPrompt = (line: string) => /^>\s*$/.test(line) || /^> /.test(line);
  const isCodexPrompt = (line: string) => /^›/.test(line) || /^codex>\s*/i.test(line);
  const isPromptLine = (line: string) => isClaudePrompt(line) || isCursorPrompt(line) || isCodexPrompt(line);
  const isPromptWithTypedInput = (line: string) => /^❯\s+\S/.test(line) || /^>\s+\S/.test(line) || /^›\s+\S/.test(line) || /^codex>\s+\S/i.test(line);
  const isAcceptEditsPrompt = (line: string) => /accept edits/i.test(line);
  const isFeedbackPrompt = (line: string) => /how is claude doing/i.test(line) || /^\s*[0-9]+:\s*(Bad|Fine|Good|Dismiss)/i.test(line);
  const isPlanModeUI = (line: string) => /^❯\s+\d+\.\s/.test(line) || /^\d+\.\s+(Yes|No|Type here)/i.test(line) || /ctrl-g to edit/i.test(line);
  const hasPrompt = tail.some(isPromptLine);
  const hasInterruptNotice = tail.some((line) => /\b(interrupted|cancelled|canceled)\b/i.test(line));
  const hasExplicitWaitingPrompt = hasExplicitInputStatus
    || tail.some(isAcceptEditsPrompt)
    || tail.some(isFeedbackPrompt)
    || tail.some(isPlanModeUI)
    || tail.some(isPromptWithTypedInput);
  const hasAgentUiMarker = tail.some((line) =>
    isAgentStatusBar(line)
    || isAcceptEditsPrompt(line)
    || isFeedbackPrompt(line)
    || isPlanModeUI(line)
    || isCodexPrompt(line)
    || /\b(Claude Code|Codex|Cursor Agent)\b/i.test(line),
  );

  // ── Primary: Claude Code hooks (deterministic, source of truth) ──
  // 5 hooks keep status accurate:
  //   PreToolUse       → "working"  (tool call — fires frequently during active work)
  //   UserPromptSubmit → "working"  (user sent input)
  //   SubagentStop     → "working"  (sub-agent done, parent still active)
  //   Stop             → "waiting"  (Claude finished responding)
  //   Notification     → "waiting"  (idle at prompt)
  //
  // Hook "waiting" is intentionally refined here: a plain idle prompt is not
  // actionable, so it should not rise above sessions that truly need input.
  if (sessionName) {
    const hookStatus = getHookStatusInfo(sessionName);
    if (hookStatus?.status === "waiting") {
      if (hasActiveBackgroundTask) return "background";
      // An active pane title may only override a waiting hook once that hook has
      // gone stale. Claude puts a spinner glyph in the title while working and
      // does not reliably clear it on the way out, so against a *fresh* Stop hook
      // the title is the less trustworthy of the two and would pin a finished
      // agent to "working". A spinner in the pane body is redrawn every frame and
      // cleared on exit, so that one counts at any age.
      const titleOutlivesHook = hasActiveTitle
        && !hasCompletionStatus
        && hookStatus.ageSeconds > FRESH_WORKING_HOOK_GRACE_SECONDS;
      if (hasWorkingIndicator || titleOutlivesHook) return "working";
      if (hasCompletionStatus) return "unknown";
      return hasExplicitWaitingPrompt ? "waiting" : "unknown";
    }
    // A fresh "working" hook is the best signal that Claude is actually doing
    // work, even if its TUI still shows an editable prompt. Older working hooks
    // can be stale when Stop/Notification did not fire, so the screen may demote
    // those into the terminal heuristics below.
    if (hookStatus?.status === "working") {
      if (hasActiveBackgroundTask && hasPrompt) return "background";
      if (hasCompletionStatus && !hasWorkingIndicator) return hasExplicitWaitingPrompt ? "waiting" : "unknown";
      if (hasExplicitWaitingPrompt && !hasWorkingIndicator && !hasActiveTitle) return "waiting";
      if (!hasInterruptNotice && hookStatus.ageSeconds <= FRESH_WORKING_HOOK_GRACE_SECONDS) return "working";
      if (!hasInterruptNotice && (hasWorkingIndicator || hasActiveTitle || !hasPrompt)) return "working";
    }
  }

  if (tail.length === 0) return SHELLS.has(command) ? "shell" : "unknown";

  // Working indicators (Cursor Agent patterns)
  if (hasWorkingIndicator || (hasActiveTitle && !hasCompletionStatus)) {
    return "working";
  }

  const lastLine = tail[tail.length - 1];

  if (hasActiveBackgroundTask && hasPrompt) {
    return "background";
  }

  if (SHELLS.has(command) && !hasAgentUiMarker) {
    return "shell";
  }

  if (hasCompletionStatus) {
    return "unknown";
  }

  if (hasExplicitWaitingPrompt) {
    return "waiting";
  }

  // A bare prompt means the session is available but not asking for action.
  if (isPromptLine(lastLine)) {
    return "unknown";
  }

  // If there is no prompt and no explicit activity indicator, avoid showing an
  // active icon. Hooks/spinner patterns will mark real work as working.
  return "unknown";
}
