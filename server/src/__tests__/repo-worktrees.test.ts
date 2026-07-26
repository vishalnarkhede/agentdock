/**
 * Tests for repo-worktrees.ts — branch listing, worktree creation and deletion.
 *
 * Drives real git repos in a temp directory: the code under test shells out to git,
 * so mocking it would only assert that we build the argv we already wrote.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as config from "../services/config";
import {
  BranchUnmergedError,
  createRepoWorktree,
  deleteRepoWorktree,
  listRepoBranches,
  WorktreeDirtyError,
} from "../services/repo-worktrees";

const CONFIG_DIR = process.env.AGENTDOCK_CONFIG_DIR!;
const WORK_DIR = join(tmpdir(), `agentdock-worktree-test-${process.pid}`);
const REPO_PATH = join(WORK_DIR, "repo");

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

/** A repo on `main` with one extra branch (`feature`) and one commit. */
async function makeRepo(): Promise<void> {
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
}

beforeEach(async () => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  mkdirSync(CONFIG_DIR, { recursive: true });
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });

  config.setBasePath(WORK_DIR);
  await makeRepo();
  config.addRepo({ alias: "repo", path: REPO_PATH });
});

afterAll(() => {
  rmSync(WORK_DIR, { recursive: true, force: true });
  rmSync(join(CONFIG_DIR, "..", ".."), { recursive: true, force: true });
});

describe("listRepoBranches", () => {
  test("lists local branches and marks the one checked out in the main worktree", async () => {
    const { branches, defaultBase } = await listRepoBranches("repo");

    expect(branches.map((b) => b.name)).toEqual(["feature", "main"]);
    expect(branches.every((b) => !b.remote)).toBe(true);
    expect(branches.find((b) => b.name === "main")?.worktreePath).toBe(REPO_PATH);
    expect(branches.find((b) => b.name === "feature")?.worktreePath).toBeUndefined();
    expect(defaultBase).toBe("main");
  });

  test("includes remote-only branches and skips the origin/HEAD pointer", async () => {
    // refs/remotes/origin/HEAD shortens to plain "origin" — it must not be offered
    // as a branch, or the UI lists a "branch" that cannot be checked out.
    await git(REPO_PATH, ["update-ref", "refs/remotes/origin/main", "refs/heads/main"]);
    await git(REPO_PATH, ["update-ref", "refs/remotes/origin/only-remote", "refs/heads/main"]);
    await git(REPO_PATH, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

    const { branches } = await listRepoBranches("repo");

    expect(branches.map((b) => b.name)).toEqual(["feature", "main", "only-remote"]);
    expect(branches.find((b) => b.name === "only-remote")).toMatchObject({
      remote: true,
      ref: "origin/only-remote",
    });
    // "main" already exists locally, so the remote copy must not be listed twice.
    expect(branches.filter((b) => b.name === "main")).toHaveLength(1);
    expect(branches.some((b) => b.name === "origin")).toBe(false);
  });

  test("offers the origin copy of a branch carried by several remotes", async () => {
    // Creation resolves a remote-only branch to origin, so the listing must agree —
    // otherwise the UI shows fork/shared and checks out origin/shared.
    await git(REPO_PATH, ["update-ref", "refs/remotes/fork/shared", "refs/heads/main"]);
    await git(REPO_PATH, ["update-ref", "refs/remotes/origin/shared", "refs/heads/main"]);

    const { branches } = await listRepoBranches("repo");

    expect(branches.filter((b) => b.name === "shared")).toHaveLength(1);
    expect(branches.find((b) => b.name === "shared")?.ref).toBe("origin/shared");
  });

  test("throws for an unknown repo alias", async () => {
    await expect(listRepoBranches("nope")).rejects.toThrow("Unknown repo 'nope'");
  });
});

describe("createRepoWorktree", () => {
  test("checks out an existing branch and registers an alias", async () => {
    const created = await createRepoWorktree({ repoAlias: "repo", branch: "feature" });

    expect(existsSync(created.path)).toBe(true);
    expect(created.branch).toBe("feature");
    expect((await git(created.path, ["branch", "--show-current"])).trim()).toBe("feature");

    const registered = config.getRepos().find((r) => r.alias === created.alias);
    expect(registered?.path).toBe(created.path);
  });

  test("creates a new branch from the given base", async () => {
    const created = await createRepoWorktree({
      repoAlias: "repo",
      branch: "wt-new",
      createBranch: true,
      base: "main",
    });

    expect((await git(created.path, ["branch", "--show-current"])).trim()).toBe("wt-new");
    // The new branch must exist in the source repo, not only in the worktree.
    expect(await git(REPO_PATH, ["branch", "--list", "wt-new"])).toContain("wt-new");
  });

  test("groups worktrees under {repo}__worktrees instead of the base path", async () => {
    const created = await createRepoWorktree({ repoAlias: "repo", branch: "feature" });
    expect(created.path).toBe(join(WORK_DIR, "repo__worktrees", "feature"));
  });

  test("flattens slashes in the branch name into the directory name", async () => {
    const created = await createRepoWorktree({
      repoAlias: "repo",
      branch: "feat/deep/name",
      createBranch: true,
      base: "main",
    });
    expect(created.path).toBe(join(WORK_DIR, "repo__worktrees", "feat-deep-name"));
    expect(created.branch).toBe("feat/deep/name");
  });

  test("grouped worktrees are not auto-registered as repos by the base-path scan", async () => {
    // scanBasePath() counts any base-path child with a .git entry as a repo, and a
    // worktree's .git is a file — so a loose worktree would get promoted to a
    // top-level repo by the syncRepos() sweep. The container dir must hide them.
    await createRepoWorktree({ repoAlias: "repo", branch: "feature", alias: "wt" });
    const scanned = config.scanBasePath().map((r) => r.path);
    expect(scanned).toEqual([REPO_PATH]);

    config.syncRepos();
    expect(config.getRepos().map((r) => r.alias).sort()).toEqual(["repo", "wt"]);
  });

  test("honors an explicit alias", async () => {
    const created = await createRepoWorktree({
      repoAlias: "repo",
      branch: "feature",
      alias: "my-wt",
    });
    expect(created.alias).toBe("my-wt");
  });

  test("rejects a new branch whose name is already taken", async () => {
    await expect(
      createRepoWorktree({ repoAlias: "repo", branch: "feature", createBranch: true }),
    ).rejects.toThrow("already exists");
  });

  test("rejects an existing-branch checkout for a branch that is not there", async () => {
    await expect(
      createRepoWorktree({ repoAlias: "repo", branch: "ghost" }),
    ).rejects.toThrow("not found");
  });

  test("rejects a branch already checked out in another worktree", async () => {
    await expect(
      createRepoWorktree({ repoAlias: "repo", branch: "main" }),
    ).rejects.toThrow("already checked out");
  });

  test("rejects an invalid branch name", async () => {
    await expect(
      createRepoWorktree({ repoAlias: "repo", branch: "bad branch", createBranch: true }),
    ).rejects.toThrow("not a valid branch name");
  });

  test("rejects an alias that is already in use, without creating the worktree", async () => {
    await expect(
      createRepoWorktree({ repoAlias: "repo", branch: "feature", alias: "repo" }),
    ).rejects.toThrow("already in use");
    expect(existsSync(join(WORK_DIR, "repo-feature"))).toBe(false);
  });
});

describe("deleteRepoWorktree", () => {
  async function branchExists(branch: string): Promise<boolean> {
    const out = await git(REPO_PATH, ["branch", "--list", branch]);
    return out.trim().length > 0;
  }

  test("removes the checkout, drops the alias, and keeps the branch", async () => {
    const created = await createRepoWorktree({ repoAlias: "repo", branch: "feature" });

    const result = await deleteRepoWorktree({ path: created.path });

    expect(existsSync(created.path)).toBe(false);
    expect(result.alias).toBe(created.alias);
    expect(result.branchDeleted).toBe(false);
    expect(config.getRepos().map((r) => r.alias)).toEqual(["repo"]);
    // The point of keeping the branch: its commits are still reachable.
    expect(await branchExists("feature")).toBe(true);
  });

  test("prunes the __worktrees container once it is empty", async () => {
    const created = await createRepoWorktree({ repoAlias: "repo", branch: "feature" });
    expect(existsSync(join(WORK_DIR, "repo__worktrees"))).toBe(true);
    await deleteRepoWorktree({ path: created.path });
    expect(existsSync(join(WORK_DIR, "repo__worktrees"))).toBe(false);
  });

  test("refuses to delete a dirty worktree, changing nothing", async () => {
    const created = await createRepoWorktree({ repoAlias: "repo", branch: "feature" });
    writeFileSync(join(created.path, "scratch.txt"), "unsaved work\n");

    await expect(deleteRepoWorktree({ path: created.path })).rejects.toBeInstanceOf(
      WorktreeDirtyError,
    );
    expect(existsSync(created.path)).toBe(true);
    expect(config.getRepos().map((r) => r.alias).sort()).toEqual([created.alias, "repo"].sort());
  });

  test("force deletes a dirty worktree", async () => {
    const created = await createRepoWorktree({ repoAlias: "repo", branch: "feature" });
    writeFileSync(join(created.path, "scratch.txt"), "unsaved work\n");

    await deleteRepoWorktree({ path: created.path, force: true });
    expect(existsSync(created.path)).toBe(false);
  });

  test("deletes the branch too when asked and it is merged", async () => {
    // 'feature' points at the same commit as main, so it is already an ancestor.
    const created = await createRepoWorktree({ repoAlias: "repo", branch: "feature" });

    const result = await deleteRepoWorktree({ path: created.path, deleteBranch: true });

    expect(result.branchDeleted).toBe(true);
    expect(await branchExists("feature")).toBe(false);
  });

  test("refuses to delete an unmerged branch, leaving the worktree intact", async () => {
    const created = await createRepoWorktree({
      repoAlias: "repo",
      branch: "solo-work",
      createBranch: true,
      base: "main",
    });
    writeFileSync(join(created.path, "new.txt"), "committed only here\n");
    await git(created.path, ["add", "-A"]);
    await git(created.path, ["commit", "-m", "unmerged work"]);

    await expect(
      deleteRepoWorktree({ path: created.path, deleteBranch: true }),
    ).rejects.toBeInstanceOf(BranchUnmergedError);

    // Nothing may be destroyed while the user still has a decision to make.
    expect(existsSync(created.path)).toBe(true);
    expect(await branchExists("solo-work")).toBe(true);
  });

  test("force deletes an unmerged branch when confirmed", async () => {
    const created = await createRepoWorktree({
      repoAlias: "repo",
      branch: "solo-work",
      createBranch: true,
      base: "main",
    });
    writeFileSync(join(created.path, "new.txt"), "committed only here\n");
    await git(created.path, ["add", "-A"]);
    await git(created.path, ["commit", "-m", "unmerged work"]);

    const result = await deleteRepoWorktree({
      path: created.path,
      deleteBranch: true,
      forceBranch: true,
    });

    expect(result.branchDeleted).toBe(true);
    expect(await branchExists("solo-work")).toBe(false);
  });

  test("refuses to delete the repo's main checkout", async () => {
    await expect(deleteRepoWorktree({ path: REPO_PATH })).rejects.toThrow("main checkout");
    expect(existsSync(REPO_PATH)).toBe(true);
  });

  test("refuses an unknown path", async () => {
    await expect(deleteRepoWorktree({ path: join(WORK_DIR, "nope") })).rejects.toThrow(
      "Not a known worktree",
    );
  });
});
