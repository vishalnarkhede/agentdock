/**
 * Route-level tests for the repo/worktree endpoints.
 *
 * These exist because service tests cannot catch routing mistakes: DELETE
 * /repos/worktrees was once shadowed by DELETE /repos/:alias, which matched first
 * and returned a cheerful {ok:true} while deleting nothing at all.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as config from "../services/config";
import app from "../routes/settings";

const CONFIG_DIR = process.env.AGENTDOCK_CONFIG_DIR!;
const WORK_DIR = join(tmpdir(), `agentdock-routes-test-${process.pid}`);
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

async function req(path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, init);
}

function json(path: string, method: string, body: unknown): Promise<Response> {
  return req(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  mkdirSync(CONFIG_DIR, { recursive: true });
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
  config.addRepo({ alias: "repo", path: REPO_PATH });
});

afterAll(() => {
  rmSync(WORK_DIR, { recursive: true, force: true });
  rmSync(join(CONFIG_DIR, "..", ".."), { recursive: true, force: true });
});

describe("worktree routes", () => {
  test("POST /repos/worktrees creates and GET lists branches", async () => {
    const res = await json("/repos/worktrees", "POST", { repoAlias: "repo", branch: "feature" });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(existsSync(created.path)).toBe(true);

    const branches = await (await req("/repos/repo/branches")).json();
    expect(branches.branches.map((b: any) => b.name)).toContain("feature");
  });

  test("DELETE /repos/worktrees actually deletes and is not shadowed by /repos/:alias", async () => {
    const created = await (
      await json("/repos/worktrees", "POST", { repoAlias: "repo", branch: "feature" })
    ).json();

    const res = await json("/repos/worktrees", "DELETE", { path: created.path });
    expect(res.status).toBe(200);
    const body = await res.json();

    // The shadowing bug returned {ok:true} from the alias route while doing nothing,
    // so assert on the delete route's own response shape and the effect on disk.
    expect(body).toMatchObject({ path: created.path, branchDeleted: false });
    expect(body.ok).toBeUndefined();
    expect(existsSync(created.path)).toBe(false);
    expect(config.getRepos().map((r) => r.alias)).toEqual(["repo"]);
  });

  test("DELETE /repos/:alias still unregisters an alias without touching disk", async () => {
    const created = await (
      await json("/repos/worktrees", "POST", { repoAlias: "repo", branch: "feature" })
    ).json();

    const res = await req(`/repos/${created.alias}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(existsSync(created.path)).toBe(true);
    expect(config.getRepos().map((r) => r.alias)).toEqual(["repo"]);
  });

  test("DELETE /repos/worktrees reports the dirty case as 409 needsForce", async () => {
    const created = await (
      await json("/repos/worktrees", "POST", { repoAlias: "repo", branch: "feature" })
    ).json();
    writeFileSync(join(created.path, "scratch.txt"), "unsaved\n");

    const res = await json("/repos/worktrees", "DELETE", { path: created.path });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ needsForce: true, changes: 1 });
    expect(existsSync(created.path)).toBe(true);
  });

  test("DELETE /repos/worktrees reports an unmerged branch as 409 needsBranchForce", async () => {
    const created = await (
      await json("/repos/worktrees", "POST", {
        repoAlias: "repo",
        branch: "solo",
        createBranch: true,
        base: "main",
      })
    ).json();
    writeFileSync(join(created.path, "new.txt"), "only here\n");
    await git(created.path, ["add", "-A"]);
    await git(created.path, ["commit", "-m", "unmerged"]);

    const res = await json("/repos/worktrees", "DELETE", {
      path: created.path,
      deleteBranch: true,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ needsBranchForce: true, branch: "solo" });
    expect(existsSync(created.path)).toBe(true);
  });

  test("DELETE /repos/worktrees requires a path", async () => {
    const res = await json("/repos/worktrees", "DELETE", {});
    expect(res.status).toBe(400);
  });
});
