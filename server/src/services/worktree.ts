import { basename, join, dirname } from "path";
import { existsSync, mkdirSync, copyFileSync, readdirSync, rmdirSync, symlinkSync } from "fs";
import { getBasePath } from "./config";
import { spawnTool } from "./spawn";

async function git(
  repoPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawnTool("git", ["-C", repoPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function firstWorktreePath(output: string): string | null {
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) return line.slice("worktree ".length);
  }
  return null;
}

/**
 * Path of the worktree that already has `branch` checked out, if any.
 *
 * Git allows a branch in only one worktree at a time, so this — not the directory
 * name — is what decides whether a worktree for a branch already exists. Keying on
 * it keeps createWorktree idempotent wherever the directory happens to live, which
 * also covers worktrees made before they were grouped under `{repo}__worktrees`.
 */
async function worktreeForBranch(
  sourceRepoPath: string,
  branch: string,
): Promise<string | null> {
  const result = await git(sourceRepoPath, ["worktree", "list", "--porcelain"]);
  if (result.exitCode !== 0) return null;

  let path: string | null = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (path && line.startsWith("branch ")) {
      const found = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      if (found === branch) return path;
    }
  }
  return null;
}

export async function getSourceRepoPath(repoPath: string): Promise<string> {
  try {
    const result = await git(repoPath, ["worktree", "list", "--porcelain"]);
    if (result.exitCode !== 0) return repoPath;
    return firstWorktreePath(result.stdout) || repoPath;
  } catch {
    return repoPath;
  }
}

/**
 * Container holding every manually-created worktree for a repo, as a sibling of
 * the repo itself: `~/projects/agentdock__worktrees/`.
 *
 * Grouping them is not just tidiness. scanBasePath() treats any base-path child
 * containing a .git entry as a standalone repo, and a worktree's .git is a file,
 * so worktrees left loose in the base path get auto-registered as top-level repos
 * by the syncRepos() sweep. The scan is one level deep and the container has no
 * .git of its own, so nesting them here keeps them out of its reach.
 */
export function worktreesDir(repoPath: string): string {
  return join(getBasePath(), `${basename(repoPath)}__worktrees`);
}

export function worktreePath(repoPath: string, branch: string): string {
  const safeBranch = branch.replace(/\//g, "-");
  return join(worktreesDir(repoPath), safeBranch);
}

export function sessionWorktreePath(sessionSlug: string, repoAlias: string): string {
  return join(getBasePath(), ".worktrees", sessionSlug, repoAlias);
}

export function sessionWorkspaceDir(sessionSlug: string): string {
  return join(getBasePath(), ".worktrees", sessionSlug);
}

export async function removeSessionWorkspace(sessionSlug: string): Promise<void> {
  const dir = sessionWorkspaceDir(sessionSlug);
  if (!existsSync(dir)) return;
  const proc = spawnTool("rm", ["-rf", dir], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;

  // Remove .worktrees/ if empty
  const worktreesDir = join(getBasePath(), ".worktrees");
  try {
    const entries = readdirSync(worktreesDir);
    if (entries.length === 0) rmdirSync(worktreesDir);
  } catch {
    // best effort
  }
}

export async function branchExists(
  repoPath: string,
  branch: string,
): Promise<boolean> {
  const { exitCode } = await git(repoPath, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  return exitCode === 0;
}

async function resolveBase(repoPath: string, base?: string): Promise<string> {
  if (base === "HEAD") {
    const head = await git(repoPath, ["rev-parse", "HEAD"]);
    if (head.exitCode === 0 && head.stdout.trim()) return head.stdout.trim();
    return "HEAD";
  }
  if (base && base !== "main" && base !== "master") return base;
  if (await branchExists(repoPath, "main")) return "main";
  if (await branchExists(repoPath, "master")) return "master";
  return "HEAD";
}

/**
 * Copy essential config files (.env*) from the main repo to the worktree.
 * Only copies small config files, not the full set of gitignored files.
 */
async function copyEnvFiles(repoPath: string, wtDir: string): Promise<void> {
  // Only copy .env files — fast glob instead of slow git ls-files scan
  const proc = spawnTool("find", [repoPath, "-maxdepth", "3", "-name", ".env*", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const files = stdout.trim().split("\n").filter(Boolean);
  for (const absPath of files) {
    const rel = absPath.slice(repoPath.length + 1);
    if (!rel) continue;
    const dest = join(wtDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    try {
      copyFileSync(absPath, dest);
    } catch {
      // best effort
    }
  }
}

export async function createWorktree(
  repoPath: string,
  branch: string,
  base?: string,
  opts?: { sessionSlug: string; repoAlias: string },
): Promise<string> {
  const sourceRepoPath = await getSourceRepoPath(repoPath);
  const wtDir = opts
    ? sessionWorktreePath(opts.sessionSlug, opts.repoAlias)
    : worktreePath(sourceRepoPath, branch);
  if (existsSync(wtDir)) {
    return wtDir;
  }
  // Session worktrees always get a freshly generated branch, so only a manual one
  // can already be checked out elsewhere — under the pre-grouping layout, say.
  // Reuse it: `worktree add` would refuse the branch anyway.
  if (!opts) {
    const existing = await worktreeForBranch(sourceRepoPath, branch);
    if (existing && existsSync(existing)) return existing;
  }
  // Ensure the containing directory exists — the session workspace for agent
  // worktrees, the repo's __worktrees dir for manual ones.
  mkdirSync(dirname(wtDir), { recursive: true });
  // Prune stale worktree entries before creating (handles cases where
  // a previous worktree directory was deleted without proper git cleanup)
  await git(sourceRepoPath, ["worktree", "prune"]);

  const exists = await branchExists(sourceRepoPath, branch);
  if (exists) {
    const result = await git(sourceRepoPath, ["worktree", "add", wtDir, branch]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create worktree for branch '${branch}': ${result.stderr.trim()}`);
    }
  } else {
    const resolved = await resolveBase(repoPath, base);
    const result = await git(sourceRepoPath, [
      "worktree",
      "add",
      wtDir,
      "-b",
      branch,
      resolved,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create worktree for new branch '${branch}': ${result.stderr.trim()}`);
    }
  }

  await copyEnvFiles(repoPath, wtDir);
  await linkHiddenEntries(repoPath, wtDir);

  // Symlink node_modules from the main repo to avoid reinstalling deps.
  // If the worktree needs different deps, the agent can run npm install
  // which will replace the symlink with a real directory.
  const mainNodeModules = join(repoPath, "node_modules");
  const wtNodeModules = join(wtDir, "node_modules");
  if (existsSync(mainNodeModules) && !existsSync(wtNodeModules)) {
    try {
      symlinkSync(mainNodeModules, wtNodeModules);
    } catch {
      // best effort
    }
  }

  return wtDir;
}

/**
 * Symlink hidden files/dirs (dot-prefixed) from the main repo into the
 * worktree, but only if git tracks at least one file under that entry.
 * This avoids symlinking tool/IDE dirs (.claude, .tanstack, .cursor, etc.)
 * that are gitignored or untracked — which would create unexpected files
 * in the worktree that could be accidentally committed.
 */
async function linkHiddenEntries(repoPath: string, wtDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = readdirSync(repoPath).filter(
      (f) => f.startsWith(".") && f !== ".git"
    );
  } catch {
    return;
  }
  for (const entry of entries) {
    const dest = join(wtDir, entry);
    if (existsSync(dest)) continue;

    // Only link if git tracks files at this path in the main repo
    const proc = spawnTool("git", ["-C", repoPath, "ls-files", "--", entry], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    if (!stdout.trim()) continue; // nothing tracked — skip

    const src = join(repoPath, entry);
    try {
      symlinkSync(src, dest);
    } catch {
      // best effort — skip entries that can't be linked
    }
  }
}

export async function removeWorktree(
  repoPath: string,
  wtDir: string,
): Promise<void> {
  if (existsSync(wtDir)) {
    await git(repoPath, ["worktree", "remove", "--force", wtDir]);
  }
  // Always prune to clean up stale registry entries (e.g. if directory was
  // already deleted but git still tracks the worktree internally)
  await git(repoPath, ["worktree", "prune"]);
}
