/**
 * Tests for status.ts — terminal output pattern matching for agent status detection.
 *
 * Tests detectStatus() and extractStatusLine() with various terminal output patterns.
 * Note: detectStatus also checks Claude Code hooks via getHookStatus(), but we test
 * the pattern-matching fallback path here (hooks return null when no session name given).
 */

import { afterEach, describe, test, expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { detectStatus, extractStatusLine, extractRecentStatusLine, displayStatusLine } from "../services/status";

const HOOK_STATUS_DIR = "/tmp/agentdock-status";
const hookSessions: string[] = [];

function writeHookStatus(sessionName: string, status: "waiting" | "working", ageSeconds = 0) {
  mkdirSync(HOOK_STATUS_DIR, { recursive: true });
  hookSessions.push(sessionName);
  writeFileSync(join(HOOK_STATUS_DIR, sessionName), JSON.stringify({ status, ts: Math.floor(Date.now() / 1000) - ageSeconds }));
}

afterEach(() => {
  for (const sessionName of hookSessions.splice(0)) {
    rmSync(join(HOOK_STATUS_DIR, sessionName), { force: true });
  }
});

// Helper: call detectStatus without session name so hooks are skipped
function detect(content: string, command = "claude"): string {
  return detectStatus(content, 0, 0, command);
}

describe("detectStatus", () => {
  // ─── Shell detection ───

  test("returns 'shell' for shell panes without visible agent UI", () => {
    expect(detect("$ ls -la", "bash")).toBe("shell");
    expect(detect("% echo hello", "zsh")).toBe("shell");
    expect(detect("prompt> pwd", "fish")).toBe("shell");
    expect(detect("$ pwd", "sh")).toBe("shell");
  });

  test("does not report shell when a shell-command pane visibly contains agent UI", () => {
    expect(detect("Some output\n❯ \n⏵⏵ bypass permissions on · 0% until auto-compact", "zsh")).toBe("unknown");
    expect(detect("Some output\n❯ \n⏵⏵ accept edits on file.ts", "zsh")).toBe("waiting");
  });

  test("does not let stale status text turn a plain shell pane into waiting", () => {
    expect(detect("[STATUS: input | old question]\n$ npm test", "zsh")).toBe("shell");
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

  test("detects Cursor and Claude working patterns", () => {
    expect(detect("Some context\nThinking...")).toBe("working");
    expect(detect("Some context\nWorking...")).toBe("working");
    expect(detect("Some context\nSearching...")).toBe("working");
    expect(detect("Some context\nReading...")).toBe("working");
    expect(detect("Some context\nEditing...")).toBe("working");
    expect(detect("Some context\nRunning...")).toBe("working");
    expect(detect("Some context\n✻ Considering… (14m 5s · ↓ 50.9k tokens)")).toBe("working");
  });

  test("does not treat Claude footer chrome alone as working", () => {
    const content = "Previous output\n❯ \n⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents";
    expect(detect(content, "zsh")).toBe("unknown");
  });

  // ─── Idle prompt detection ───

  test("detects bare Claude prompt (❯) as unknown", () => {
    expect(detect("Previous output\n❯ ")).toBe("unknown");
    expect(detect("Previous output\n❯")).toBe("unknown");
  });

  test("detects bare Cursor prompt (>) as unknown", () => {
    expect(detect("Previous output\n> ")).toBe("unknown");
    expect(detect("Previous output\n>")).toBe("unknown");
  });

  test("detects bare Codex prompt as unknown", () => {
    expect(detect("Previous output\n› ", "codex")).toBe("unknown");
    expect(detect("Previous output\ncodex> ", "codex")).toBe("unknown");
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

  test("fresh working hook wins even when Claude shows a prompt", () => {
    const sessionName = `agentdock-test-fresh-working-prompt-${Date.now()}`;
    writeHookStatus(sessionName, "working");
    expect(detectStatus("Previous output\n❯ ", 0, 0, "claude", sessionName)).toBe("working");
  });

  test("active tmux title keeps working when Claude's hook is stale waiting", () => {
    const sessionName = `agentdock-test-title-working-${Date.now()}`;
    writeHookStatus(sessionName, "waiting", 45);
    const content = "Previous output\n❯ commit this\n⏵⏵ auto mode on";
    expect(detectStatus(content, 0, 0, "zsh", sessionName, "✳ test-agent")).toBe("working");
  });

  // Claude leaves the spinner glyph in the pane title after it finishes, so
  // against a hook that *just* said waiting the title is the stale signal of the
  // two. Letting it win here is what pinned finished agents to "working".
  test("stale tmux title does not override a fresh waiting hook", () => {
    const sessionName = `agentdock-test-title-fresh-waiting-${Date.now()}`;
    writeHookStatus(sessionName, "waiting", 2);
    const content = "Previous output\n❯ commit this\n⏵⏵ auto mode on";
    expect(detectStatus(content, 0, 0, "zsh", sessionName, "⠂ test-agent")).toBe("waiting");
  });

  // Claude trails the final message with "⎿ …" tool results, tips and classifier
  // notes. Treating those as "the agent moved on" threw away the done status,
  // which left nothing to demote the title and showed the agent as working.
  test("recent done status beats prompt text when hook says waiting", () => {
    const sessionName = `agentdock-test-done-prompt-${Date.now()}`;
    writeHookStatus(sessionName, "waiting");
    const content = [
      "[STATUS: done | changes complete and verified, awaiting next task]",
      "✻ Baked for 5s",
      "──────────────── test-agent ──",
      "❯ commit this",
      "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ].join("\n");

    const status = detectStatus(content, 0, 0, "zsh", sessionName);
    expect(status).toBe("unknown");
    expect(displayStatusLine(content, status)).toEqual({ type: "done", message: "changes complete and verified, awaiting next task" });
  });

  test("visible prompt overrides stale working hook", () => {
    const sessionName = `agentdock-test-working-prompt-${Date.now()}`;
    writeHookStatus(sessionName, "working", 45);
    expect(detectStatus("Previous output\n❯ ", 0, 0, "claude", sessionName)).toBe("unknown");
  });

  test("interrupt notice overrides stale working hook", () => {
    const sessionName = `agentdock-test-interrupted-${Date.now()}`;
    writeHookStatus(sessionName, "working");
    expect(detectStatus("Working on files\nInterrupted by user", 0, 0, "claude", sessionName)).toBe("unknown");
  });

  test("recent working hook still wins when no idle prompt is visible", () => {
    const sessionName = `agentdock-test-working-${Date.now()}`;
    writeHookStatus(sessionName, "working");
    expect(detectStatus("Reading repository files", 0, 0, "claude", sessionName)).toBe("working");
  });

  test("recent working hook stays working when Claude shows an explicit working line", () => {
    const sessionName = `agentdock-test-working-statusbar-${Date.now()}`;
    writeHookStatus(sessionName, "working");
    const content = "✻ Considering… (14m 5s · ↓ 50.9k tokens)\n❯ \n⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents";
    expect(detectStatus(content, 0, 0, "zsh", sessionName)).toBe("working");
  });

  test("stale Claude completion marker does not keep a working hook working", () => {
    const sessionName = `agentdock-test-working-churned-${Date.now()}`;
    writeHookStatus(sessionName, "working", 45);
    const content = "[STATUS: done | finished]\n✻ Churned for 17m 2s\n❯ \n⏵⏵ auto mode on (shift+tab to cycle) · ← for agents";
    expect(detectStatus(content, 0, 0, "zsh", sessionName, "✳ test-agent")).toBe("unknown");
  });

  // A prompt only *demotes* the hook to the terminal heuristics — it does not force
  // "unknown". A spinner alongside the prompt still means the agent is working.
  test("spinner beside a visible prompt keeps a working hook working", () => {
    const sessionName = `agentdock-test-working-spinner-${Date.now()}`;
    writeHookStatus(sessionName, "working");
    expect(detectStatus("⠹ Crunching files\n❯ ", 0, 0, "claude", sessionName)).toBe("working");
  });

  test("explicit waiting prompt still beats a working hook", () => {
    const sessionName = `agentdock-test-working-accept-${Date.now()}`;
    writeHookStatus(sessionName, "working");
    expect(detectStatus("Editing file\n⏵⏵ accept edits on", 0, 0, "claude", sessionName)).toBe("waiting");
  });

  test("prompt without (running) is idle", () => {
    expect(detect("Some output\n❯ \n⏵⏵ bypass permissions on · 0% until auto-compact")).toBe("unknown");
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

  // ─── Ambiguous output ───

  test("returns 'unknown' when no prompt or active indicator is detected", () => {
    expect(detect("Processing files...\nUpdated 3 files")).toBe("unknown");
  });

  // ─── Divider lines are skipped ───

  test("skips divider lines when looking for tail", () => {
    // The prompt is above a long divider — still idle, not actionable.
    expect(detect("❯ \n────────────────────")).toBe("unknown");
  });

  // ─── ANSI escape codes ───

  test("strips ANSI escape codes before matching", () => {
    expect(detect("\x1b[32mSome output\x1b[0m\n\x1b[1m❯\x1b[0m ")).toBe("unknown");
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

  test("ignores recent status lines that have normal output after them", () => {
    const content = [
      "[STATUS: input | old question]",
      "Reading files",
      "Editing files",
    ].join("\n");

    expect(extractRecentStatusLine(content)).toBeNull();
    expect(displayStatusLine(content, "unknown")).toBeNull();
    expect(detect(content)).toBe("unknown");
  });

  test("keeps status lines followed only by agent prompt chrome", () => {
    const content = [
      "[STATUS: done | implemented login page]",
      "❯ ",
      "⏵⏵ bypass permissions on · 0% until auto-compact",
    ].join("\n");

    expect(extractRecentStatusLine(content)).toEqual({ type: "done", message: "implemented login page" });
    expect(displayStatusLine(content, "unknown")).toEqual({ type: "done", message: "implemented login page" });
  });

  test("keeps done status through Claude completion footer and typed prompt", () => {
    const content = [
      "[STATUS: done | changes complete and verified, awaiting next task]",
      "✻ Baked for 5s",
      "──────────────── test-agent ──",
      "❯ commit this",
      "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ].join("\n");

    expect(extractRecentStatusLine(content)).toEqual({ type: "done", message: "changes complete and verified, awaiting next task" });
    expect(displayStatusLine(content, "waiting")).toEqual({ type: "done", message: "changes complete and verified, awaiting next task" });
  });

  test("keeps done status through Claude cooked footer and stale active title", () => {
    const sessionName = `agentdock-test-done-cooked-${Date.now()}`;
    writeHookStatus(sessionName, "waiting", 300);
    const content = [
      "[STATUS: done | verified green]",
      "✻ Cooked for 46s",
      "──────────────── test-agent ──",
      "❯ commit this",
      "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ].join("\n");

    const status = detectStatus(content, 0, 0, "zsh", sessionName, "✳ test-agent");
    expect(status).toBe("unknown");
    expect(displayStatusLine(content, status)).toEqual({ type: "done", message: "verified green" });
  });

  test("keeps wrapped done status through Claude crunched footer and stale active title", () => {
    const sessionName = `agentdock-test-done-wrapped-crunched-${Date.now()}`;
    writeHookStatus(sessionName, "waiting", 300);
    const content = [
      "[STATUS: done | verified green, 232 tests pass, changes uncommitted in the",
      "working tree]",
      "✻ Crunched for 4s",
      "──────────────── test-agent ──",
      "❯ commit this",
      "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ].join("\n");

    const status = detectStatus(content, 0, 0, "zsh", sessionName, "✳ test-agent");
    const statusLine = { type: "done", message: "verified green, 232 tests pass, changes uncommitted in the working tree" };
    expect(status).toBe("unknown");
    expect(extractStatusLine(content)).toEqual(statusLine);
    expect(extractRecentStatusLine(content, 30)).toEqual(statusLine);
    expect(displayStatusLine(content, "working")).toEqual(statusLine);
    expect(displayStatusLine(content, status)).toEqual(statusLine);
  });

  // Verbatim from a real pane that showed a working icon after finishing: a tip
  // long enough to wrap continues as bare prose on the next line, which no chrome
  // pattern matches, and that discarded the done status.
  test("keeps done status through a wrapped ⎿ tip block", () => {
    const content = [
      "[STATUS: done | instrumented the live session]",
      "✻ Sautéed for 1m 28s",
      "⎿  Tip: Dynamic workflows let Claude write a script that orchestrates many agents for you. Mention the keyword ultracode or ask",
      "Claude to use a workflow directly.",
      "───────────────────────── test-agent ──",
      "❯",
      "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ].join("\n");

    expect(extractRecentStatusLine(content, 30)?.type).toBe("done");
  });

});

/**
 * Chrome the parser has never been taught must not invalidate a completion
 * status. This bug recurred three times — "Sautéed for 1m 28s", a wrapped
 * "⎿ Tip:", then "※ recap:" — each time because the parser listed the chrome it
 * tolerated. It now asks what *started* a new turn instead, so these cases hold
 * for chrome that does not exist yet.
 */
describe("status line survives unrecognised chrome", () => {
  const STATUS = "[STATUS: done | 242 tests pass]";
  const INPUT_BOX = [
    "─────────────────── test-agent ──",
    "❯ ",
    "───────────────────────────────────",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
  ];
  const withChrome = (...chrome: string[]) => [STATUS, ...chrome, ...INPUT_BOX].join("\n");

  test("a recap block and its wrapped continuation", () => {
    const content = withChrome(
      "✻ Baked for 3s",
      "※ recap: You asked me to address findings from a review of your uncommitted changes, then fixed a bug where finished agents",
      "  show as working. (disable recaps in /config)",
    );
    expect(extractRecentStatusLine(content, 30)?.type).toBe("done");
  });

  test("chrome that does not exist yet", () => {
    const content = withChrome(
      "◈ digest: 4 files touched, 2 tests added",
      "  spanning three repositories in the workspace",
      "☰ context: 68% remaining until auto-compact",
      "  ⧗ 1m 4s · ↓ 12.3k tokens",
    );
    expect(extractRecentStatusLine(content, 30)?.type).toBe("done");
  });

  // The other half of the contract: a genuinely new turn must still invalidate.
  test("still discards on an assistant message", () => {
    expect(extractRecentStatusLine(withChrome("✻ Baked for 3s", "● Here is the next thing."), 30)).toBeNull();
  });

  test("still discards on a spinner with an unknown verb", () => {
    expect(extractRecentStatusLine(withChrome("· Beaming… (38s · ↓ 2.5k tokens)"), 30)).toBeNull();
  });

  test("still discards on a submitted prompt, but not on input-box draft text", () => {
    const submitted = [STATUS, "✻ Baked for 3s", "❯ do the next thing", "● On it.", ...INPUT_BOX].join("\n");
    expect(extractRecentStatusLine(submitted, 30)).toBeNull();

    // The input box is always the last prompt on screen, so text there is a draft.
    const draft = [STATUS, "✻ Baked for 3s", "─────── test-agent ──", "❯ commit this", "  ⏵⏵ auto mode on"].join("\n");
    expect(extractRecentStatusLine(draft, 30)?.type).toBe("done");
  });
});
