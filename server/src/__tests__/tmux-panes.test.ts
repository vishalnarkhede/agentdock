/**
 * Tests for pane-level tmux helpers, against a real tmux server.
 *
 * Drives an actual throwaway session rather than mocking: the bug these cover is
 * tmux's own behaviour, not ours — `display-message -t` silently falls back to the
 * current pane for a dead target and exits 0, so a mocked runner would have happily
 * confirmed the broken implementation.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { hasPane, listAllPanes, isAgentCommand, sessionHasAgentPane, createSession } from "../services/tmux";

const SESSION = `agentdock-panetest-${process.pid}`;

async function tmux(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  return { stdout, exitCode: await proc.exited };
}

let livePaneId = "";
let available = false;

beforeAll(async () => {
  const created = await tmux(["new-session", "-d", "-s", SESSION, "-c", "/tmp"]);
  available = created.exitCode === 0;
  if (!available) return;
  const id = await tmux(["list-panes", "-t", SESSION, "-F", "#{pane_id}"]);
  livePaneId = id.stdout.trim().split("\n")[0] ?? "";
});

afterAll(async () => {
  if (available) await tmux(["kill-session", "-t", SESSION]);
});

describe("hasPane", () => {
  test("is true for a live pane", async () => {
    if (!available) return;
    expect(await hasPane(livePaneId)).toBe(true);
  });

  test("is false for a pane id that no longer exists", async () => {
    if (!available) return;
    // The regression: display-message exits 0 here and reports the *current* pane,
    // which left a closed external agent streaming forever instead of disconnecting.
    expect(await hasPane("%999999")).toBe(false);
  });
});

describe("listAllPanes", () => {
  test("finds panes across sessions, with coordinates and cwd", async () => {
    if (!available) return;
    const panes = await listAllPanes();
    const mine = panes.find((pane) => pane.sessionName === SESSION);

    expect(mine).toBeDefined();
    expect(mine!.id).toBe(livePaneId);
    expect(mine!.path).toBe("/tmp");
    expect(Number.isNaN(mine!.windowIndex)).toBe(false);
    expect(Number.isNaN(mine!.paneIndex)).toBe(false);
  });
});

describe("sessionHasAgentPane", () => {
  test("is false for a plain shell session", async () => {
    if (!available) return;
    expect(await sessionHasAgentPane(SESSION)).toBe(false);
  });
});

describe("createSession with an initial command", () => {
  // The agent is exec'd so it becomes the pane's own process — that is what makes
  // #{pane_current_command} report the agent rather than the shell, which
  // isAgentCommand() and the shell branch of detectStatus() both depend on.
  test("the command becomes the pane's process, not a child of the shell", async () => {
    if (!available) return;
    const name = `agentdock-exec-${process.pid}`;
    await createSession(name, "/tmp", undefined, "exec sleep 30");
    try {
      // new-session returns before the shell has exec'd, so the pane reports the
      // shell for a moment first. Poll rather than assert on the first read.
      let cmd = "";
      for (let i = 0; i < 40; i++) {
        const res = await tmux(["list-panes", "-t", name, "-F", "#{pane_current_command}"]);
        cmd = res.stdout.trim();
        if (cmd === "sleep") break;
        await Bun.sleep(50);
      }
      expect(cmd).toBe("sleep");
      expect(isAgentCommand(cmd)).toBe(false); // sanity: the helper reads this field
    } finally {
      await tmux(["kill-session", "-t", name]);
    }
  });

  // A binary that is not on PATH exits 127 the moment the pane starts. Without
  // remain-on-exit the session is gone before the error can be read.
  test("survives a command that fails to start, keeping the error on screen", async () => {
    if (!available) return;
    const name = `agentdock-deadcmd-${process.pid}`;
    await createSession(name, "/tmp", undefined, "exec agentdock-no-such-binary");
    try {
      await Bun.sleep(600);
      const alive = await tmux(["has-session", "-t", name]);
      expect(alive.exitCode).toBe(0);
      const pane = await tmux(["capture-pane", "-p", "-S", "-20", "-t", name]);
      expect(pane.stdout).toContain("agentdock-no-such-binary");
    } finally {
      await tmux(["kill-session", "-t", name]);
    }
  });
});

describe("isAgentCommand", () => {
  test("recognises the agent CLIs and nothing else", () => {
    expect(isAgentCommand("claude")).toBe(true);
    expect(isAgentCommand("codex")).toBe(true);
    expect(isAgentCommand("agent")).toBe(true);
    expect(isAgentCommand("zsh")).toBe(false);
    expect(isAgentCommand("workmux")).toBe(false);
  });

  test("normalises a full path to the binary", () => {
    expect(isAgentCommand("/opt/homebrew/bin/claude")).toBe(true);
  });
});
