/**
 * Tests for worktree.ts — the path layout and createWorktree's idempotency.
 *
 * Drives real git repos in a temp directory: the code under test shells out to git,
 * so mocking it would only assert that we build the argv we already wrote.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as config from "../services/config";
import { createWorktree, worktreePath, worktreesDir } from "../services/worktree";

const CONFIG_DIR = process.env.AGENTDOCK_CONFIG_DIR!;
const WORK_DIR = join(tmpdir(), `agentdock-worktree-unit-test-${process.pid}`);
const REPO_PATH = join(WORK_DIR, "repo");

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

beforeEach(async () => {
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
  config.setBasePath(WORK_DIR);

  mkdirSync(REPO_PATH, { recursive: true });
  await git(REPO_PATH, ["init", "-b", "main"]);
  await git(REPO_PATH, ["config", "user.email", "test@example.com"]);
  await git(REPO_PATH, ["config", "user.name", "Test"]);
  // Without this, a developer's ~/.gitconfig signing key can hang every fixture commit.
  await git(REPO_PATH, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(REPO_PATH, "README.md"), "hello\n");
  await git(REPO_PATH, ["add", "."]);
  await git(REPO_PATH, ["commit", "-m", "init"]);
  await git(REPO_PATH, ["branch", "feature"]);
});

afterAll(() => {
  rmSync(WORK_DIR, { recursive: true, force: true });
  rmSync(join(CONFIG_DIR, "..", ".."), { recursive: true, force: true });
});

describe("createWorktree", () => {
  test("groups a manual worktree under {repo}__worktrees", async () => {
    const dir = await createWorktree(REPO_PATH, "feature");

    expect(dir).toBe(worktreePath(REPO_PATH, "feature"));
    expect(dir).toBe(join(worktreesDir(REPO_PATH), "feature"));
    expect(existsSync(join(dir, "README.md"))).toBe(true);
  });

  test("returns the same directory when called twice for one branch", async () => {
    const first = await createWorktree(REPO_PATH, "feature");
    const second = await createWorktree(REPO_PATH, "feature");

    expect(second).toBe(first);
  });

  test("reuses a worktree that predates the __worktrees grouping", async () => {
    // How worktrees were laid out before: a sibling of the repo in the base path.
    // git refuses to check the branch out twice, so without reusing this the call
    // would fail outright for anyone upgrading with worktrees already on disk.
    const legacy = join(WORK_DIR, "repo-feature");
    await git(REPO_PATH, ["worktree", "add", legacy, "feature"]);

    const dir = await createWorktree(REPO_PATH, "feature");

    expect(dir).toBe(legacy);
    expect(existsSync(worktreePath(REPO_PATH, "feature"))).toBe(false);
  });

  test("still creates a new worktree when the branch is checked out nowhere", async () => {
    const legacy = join(WORK_DIR, "repo-feature");
    await git(REPO_PATH, ["worktree", "add", legacy, "feature"]);
    await git(REPO_PATH, ["worktree", "remove", legacy]);

    const dir = await createWorktree(REPO_PATH, "feature");

    expect(dir).toBe(worktreePath(REPO_PATH, "feature"));
    expect(existsSync(dir)).toBe(true);
  });
});
