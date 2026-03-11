import { basename, join, dirname } from "path";
import { existsSync, mkdirSync, copyFileSync, readdirSync, rmdirSync } from "fs";
import { getBasePath } from "./config";

async function git(
  repoPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", "-C", repoPath, ...args], {
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

export function worktreePath(repoPath: string, branch: string): string {
  const safeBranch = branch.replace(/\//g, "-");
  return join(getBasePath(), `${basename(repoPath)}-${safeBranch}`);
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
  const proc = Bun.spawn(["rm", "-rf", dir], { stdout: "pipe", stderr: "pipe" });
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
  const proc = Bun.spawn(["find", repoPath, "-maxdepth", "3", "-name", ".env*", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"], {
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
  const wtDir = opts
    ? sessionWorktreePath(opts.sessionSlug, opts.repoAlias)
    : worktreePath(repoPath, branch);
  if (existsSync(wtDir)) {
    return wtDir;
  }
  // Ensure parent directory exists for session worktrees
  mkdirSync(dirname(wtDir), { recursive: true });
  // Prune stale worktree entries before creating (handles cases where
  // a previous worktree directory was deleted without proper git cleanup)
  await git(repoPath, ["worktree", "prune"]);

  const exists = await branchExists(repoPath, branch);
  if (exists) {
    const result = await git(repoPath, ["worktree", "add", wtDir, branch]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create worktree for branch '${branch}': ${result.stderr.trim()}`);
    }
  } else {
    const resolved = await resolveBase(repoPath, base);
    const result = await git(repoPath, [
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

  return wtDir;
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
