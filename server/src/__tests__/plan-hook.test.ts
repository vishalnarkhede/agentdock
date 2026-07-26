/**
 * Tests for the plan capture hook, run as the real shell script against real tmux.
 *
 * The hook's whole job is to decide *which* file to copy and *what to call it*, from
 * a JSON payload and the tmux pane it happens to be running in. Mocking either side
 * would only assert that the script we wrote is the script we wrote.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, copyFileSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const WORK_DIR = join(tmpdir(), `agentdock-planhook-test-${process.pid}`);
const CFG_DIR = join(WORK_DIR, "cfg");
const HOOK = join(CFG_DIR, "hooks", "plan-hook.sh");
const PLANS = join(CFG_DIR, "plans");
const SOURCE = join(import.meta.dir, "..", "hooks", "plan-hook.sh");

/** A path shaped like Claude Code's plan-mode output. */
const PLAN_FILE = join(WORK_DIR, "repo", ".claude", "plans", "some-descriptive-slug.md");

async function tmux(args: string[]): Promise<number> {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  return proc.exited;
}

/** Run the hook inside a real tmux session, feeding it a PostToolUse payload. */
async function runHookIn(session: string, payload: unknown): Promise<void> {
  const marker = join(WORK_DIR, `done-${session}`);
  const json = JSON.stringify(payload).replace(/'/g, `'\\''`);
  await tmux([
    "send-keys", "-t", session,
    `printf '%s' '${json}' | ${HOOK}; touch ${marker}`,
    "Enter",
  ]);
  // Stays inside the 5s per-test budget, so a hook that never runs fails on the
  // assertion below rather than as an unexplained timeout.
  for (let i = 0; i < 40 && !existsSync(marker); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

const SESSIONS = [`adk-ext-${process.pid}`, `claude-adk-${process.pid}`];
let available = false;

beforeAll(async () => {
  mkdirSync(join(CFG_DIR, "hooks"), { recursive: true });
  copyFileSync(SOURCE, HOOK);
  chmodSync(HOOK, 0o755);

  // A bare shell, not the developer's login shell: a profile that prompts for
  // anything (ssh-add, a passphrase) swallows the keys sent below and the hook
  // never runs.
  const created = await Promise.all(
    SESSIONS.map((s) =>
      tmux(["new-session", "-d", "-s", s, "-c", "/tmp", "bash", "--noprofile", "--norc"]),
    ),
  );
  available = created.every((code) => code === 0);
});

beforeEach(() => {
  rmSync(PLANS, { recursive: true, force: true });
  mkdirSync(join(WORK_DIR, "repo", ".claude", "plans"), { recursive: true });
  writeFileSync(PLAN_FILE, "# The Plan\n");
});

afterAll(async () => {
  await Promise.all(SESSIONS.map((s) => tmux(["kill-session", "-t", s])));
  rmSync(WORK_DIR, { recursive: true, force: true });
});

describe("plan-hook", () => {
  test("files a plan under the pane id when the session isn't AgentDock's", async () => {
    if (!available) return;
    const paneId = (
      await new Response(
        Bun.spawn(["tmux", "list-panes", "-t", SESSIONS[0], "-F", "#{pane_id}"], {
          stdout: "pipe",
        }).stdout,
      ).text()
    ).trim();

    await runHookIn(SESSIONS[0], { tool_name: "Write", tool_input: { file_path: PLAN_FILE } });

    // Matches the `external-<n>` name the server gives these agents, so the existing
    // per-session lookup finds it with no extra mapping.
    const expected = join(PLANS, `external-${paneId.replace("%", "")}.md`);
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, "utf-8")).toBe("# The Plan\n");
  });

  test("files it under the session name for an AgentDock-launched agent", async () => {
    if (!available) return;
    // Those sessions are keyed by name — the same path the injected system prompt
    // tells the agent to write — so the hook reinforces it rather than competing.
    await runHookIn(SESSIONS[1], { tool_name: "Write", tool_input: { file_path: PLAN_FILE } });

    expect(existsSync(join(PLANS, `${SESSIONS[1]}.md`))).toBe(true);
  });

  test("ignores writes that aren't plan-mode files", async () => {
    if (!available) return;
    const other = join(WORK_DIR, "repo", "README.md");
    writeFileSync(other, "not a plan\n");

    await runHookIn(SESSIONS[0], { tool_name: "Write", tool_input: { file_path: other } });

    expect(existsSync(PLANS)).toBe(false);
  });

  test("ignores a payload with no file_path", async () => {
    if (!available) return;
    await runHookIn(SESSIONS[0], { tool_name: "Bash", tool_input: { command: "ls" } });

    expect(existsSync(PLANS)).toBe(false);
  });

  test("exits promptly when stdin never arrives", async () => {
    if (!available) return;
    // The read is bounded because this runs on every Write and Edit: an unbounded
    // `cat` waiting on an empty stdin would hang the agent's tool call outright.
    const started = Date.now();
    const proc = Bun.spawn([HOOK], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    // Deliberately never write, never close: this is the hang case.
    const exitCode = await proc.exited;
    const elapsed = Date.now() - started;

    expect(exitCode).toBe(0);
    expect(elapsed).toBeLessThan(5000);
  });
});
