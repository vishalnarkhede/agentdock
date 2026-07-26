/**
 * Tests for shell-sessions.ts — the plain shells behind the Shell tab.
 *
 * Runs against a real tmux server for the lifecycle cases: the thing worth
 * proving is that a shell reattaches rather than piling up a new session each
 * time the tab is opened, and that it is named so it can never be mistaken for
 * an agent by listSessions(PREFIX).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  SHELL_PREFIX,
  shellSessionName,
  ensureShellSession,
  listShellSessions,
  killShellSessions,
} from "../services/shell-sessions";
import { listSessions, hasSession } from "../services/tmux";
import { PREFIX } from "../services/config";

const AGENT = `${PREFIX}-shelltest-${process.pid}`;
const WORK_DIR = join(tmpdir(), `agentdock-shell-test-${process.pid}`);
const WT_A = join(WORK_DIR, "repo-a");
const WT_B = join(WORK_DIR, "repo-b");

let available = false;

beforeAll(async () => {
  mkdirSync(WT_A, { recursive: true });
  mkdirSync(WT_B, { recursive: true });
  const probe = Bun.spawn(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
  available = (await probe.exited) === 0;
});

afterAll(async () => {
  if (available) await killShellSessions(AGENT);
  rmSync(WORK_DIR, { recursive: true, force: true });
});

describe("shellSessionName", () => {
  test("is stable for the same worktree", () => {
    expect(shellSessionName(AGENT, WT_A)).toBe(shellSessionName(AGENT, WT_A));
  });

  test("differs per worktree, so one agent can hold several shells", () => {
    expect(shellSessionName(AGENT, WT_A)).not.toBe(shellSessionName(AGENT, WT_B));
  });

  // The sidebar is built from listSessions(PREFIX). A shell that matched would
  // render as an agent row for a session that does not exist.
  test("cannot be picked up as an agent by the PREFIX filter", () => {
    const name = shellSessionName(AGENT, WT_A);
    expect(name.startsWith(`${SHELL_PREFIX}-`)).toBe(true);
    expect(name.startsWith(`${PREFIX}-`)).toBe(false);
  });
});

describe("ensureShellSession", () => {
  test("creates the shell in the worktree, then reattaches instead of duplicating", async () => {
    if (!available) return;
    const first = await ensureShellSession(AGENT, WT_A);
    expect(await hasSession(first)).toBe(true);

    const second = await ensureShellSession(AGENT, WT_A);
    expect(second).toBe(first);
    expect(await listShellSessions(AGENT)).toHaveLength(1);
  });

  test("a second worktree gets its own shell", async () => {
    if (!available) return;
    await ensureShellSession(AGENT, WT_A);
    await ensureShellSession(AGENT, WT_B);
    expect((await listShellSessions(AGENT)).sort()).toEqual(
      [shellSessionName(AGENT, WT_A), shellSessionName(AGENT, WT_B)].sort(),
    );
  });

  test("the shell does not appear among agent sessions", async () => {
    if (!available) return;
    await ensureShellSession(AGENT, WT_A);
    const agents = await listSessions(PREFIX);
    expect(agents.map((s) => s.name)).not.toContain(shellSessionName(AGENT, WT_A));
  });
});

describe("killShellSessions", () => {
  test("removes every shell for the agent", async () => {
    if (!available) return;
    await ensureShellSession(AGENT, WT_A);
    await ensureShellSession(AGENT, WT_B);
    await killShellSessions(AGENT);

    expect(await listShellSessions(AGENT)).toHaveLength(0);
    expect(await hasSession(shellSessionName(AGENT, WT_A))).toBe(false);
    expect(await hasSession(shellSessionName(AGENT, WT_B))).toBe(false);
  });

  test("is a no-op when the agent has no shells", async () => {
    if (!available) return;
    await killShellSessions(`${PREFIX}-never-had-a-shell-${process.pid}`);
  });
});
