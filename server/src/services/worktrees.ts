/**
 * Every worktree on disk, and who owns it.
 *
 * AgentDock creates a worktree per isolated session and removes it when the
 * session is killed — but a session killed by hand, a crash, or a worktree made
 * outside AgentDock all leave one behind, and nothing in the UI could show you
 * that. This asks git rather than reading AgentDock's own records, so what it
 * lists is what is actually there: worktrees with a session, worktrees whose
 * session is gone, and worktrees AgentDock never made.
 */

import { getRepos, getAllSessionMetas, PREFIX } from "./config";
import { existsSync } from "fs";

export interface WorktreeInfo {
  /** Absolute path of the worktree directory. */
  path: string;
  /** Repo alias if configured, else the directory name. */
  repo: string;
  repoPath: string;
  /** Branch name, or null when the worktree is on a detached HEAD. */
  branch: string | null;
  head: string;
  /** The repo's own working tree rather than a linked worktree. */
  primary: boolean;
  /** The session that owns it, without the agent prefix, or null. */
  session: string | null;
  /** Full tmux session name, for jumping to it. */
  sessionName: string | null;
  /** git considers the directory missing. */
  prunable: boolean;
  exists: boolean;
  /** Tracked files with changes, or null when it could not be read. */
  dirty: number | null;
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; ok: boolean }> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(proc.stdout).text();
    return { stdout, ok: (await proc.exited) === 0 };
  } catch {
    return { stdout: "", ok: false };
  }
}

/**
 * Parses `git worktree list --porcelain`.
 *
 * Records are separated by a blank line and the first is always the repo's own
 * working tree. `branch refs/heads/x` is absent on a detached HEAD, which is
 * the normal state for a worktree checked out at a tag or a sha.
 */
export function parseWorktreeList(stdout: string): {
  path: string;
  head: string;
  branch: string | null;
  prunable: boolean;
}[] {
  const out: { path: string; head: string; branch: string | null; prunable: boolean }[] = [];
  let current: { path: string; head: string; branch: string | null; prunable: boolean } | null = null;

  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) {
      if (current) out.push(current);
      current = null;
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? "" : line.slice(sp + 1);

    if (key === "worktree") {
      if (current) out.push(current);
      current = { path: value, head: "", branch: null, prunable: false };
    } else if (!current) {
      continue;
    } else if (key === "HEAD") {
      current.head = value.slice(0, 10);
    } else if (key === "branch") {
      current.branch = value.replace(/^refs\/heads\//, "");
    } else if (key === "prunable") {
      current.prunable = true;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Which session owns which worktree directory, by absolute path. */
export function ownersByPath(metas: Record<string, { repoPath: string; wtDir: string }[]>): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [session, list] of Object.entries(metas)) {
    for (const meta of list) owners.set(meta.wtDir, session);
  }
  return owners;
}

export async function listAllWorktrees(): Promise<WorktreeInfo[]> {
  const repos = getRepos();
  const owners = ownersByPath(getAllSessionMetas());

  const perRepo = await Promise.all(
    repos.map(async (repo) => {
      const { stdout, ok } = await git(repo.path, ["worktree", "list", "--porcelain"]);
      if (!ok) return [];
      return parseWorktreeList(stdout).map((wt, i) => ({
        ...wt,
        repo: repo.alias || repo.path.split("/").filter(Boolean).pop() || repo.path,
        repoPath: repo.path,
        primary: i === 0,
      }));
    }),
  );

  const flat = perRepo.flat();

  /* One `git status` per worktree, in parallel: whether a worktree still holds
     work is the question you ask right after "why is this still here". */
  const dirty = await Promise.all(
    flat.map(async (wt) => {
      if (!existsSync(wt.path)) return null;
      const { stdout, ok } = await git(wt.path, ["status", "--porcelain", "--untracked-files=no"]);
      if (!ok) return null;
      return stdout.split("\n").filter((l) => l.trim()).length;
    }),
  );

  return flat.map((wt, i) => {
    const session = owners.get(wt.path) ?? null;
    return {
      path: wt.path,
      repo: wt.repo,
      repoPath: wt.repoPath,
      branch: wt.branch,
      head: wt.head,
      primary: wt.primary,
      session: session ? session.replace(`${PREFIX}-`, "") : null,
      sessionName: session,
      prunable: wt.prunable,
      exists: existsSync(wt.path),
      dirty: dirty[i],
    };
  });
}
