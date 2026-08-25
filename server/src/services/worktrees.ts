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

import { getRepos, getAllSessionMetas, getBasePath, PREFIX } from "./config";
import { existsSync, readdirSync, rmdirSync } from "fs";
import { dirname, join } from "path";

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

/**
 * One entry per worktree, keeping the first.
 *
 * Configured repos are not necessarily distinct repositories: several of them
 * can be worktrees of the same one, and `git worktree list` run in any of them
 * reports the whole set. Scanning each configured repo therefore returns the
 * same worktree several times — 130 records for 101 worktrees here — which the
 * list then rendered with duplicate React keys, and a duplicate key breaks
 * reconciliation: filtering left stale rows on screen.
 */
export function dedupeByPath<T extends { path: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of list) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    out.push(item);
  }
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

  /* Two configured repos that are worktrees of the same repository would each
     report the whole set, so scan one repo per repository. The common git dir
     is what identifies a repository — a worktree's points back at its parent. */
  const byRepository = new Map<string, (typeof repos)[number]>();
  await Promise.all(
    repos.map(async (repo) => {
      const { stdout, ok } = await git(repo.path, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
      const key = ok && stdout.trim() ? stdout.trim() : repo.path;
      if (!byRepository.has(key)) byRepository.set(key, repo);
    }),
  );

  const perRepo = await Promise.all(
    [...byRepository.values()].map(async (repo) => {
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

  /* Belt and braces: one repository can still be reached by two paths that
     resolve to different common dirs (a symlinked checkout), and a duplicate
     key is worse than a missing row. */
  const flat = dedupeByPath(perRepo.flat());

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

/**
 * Whether a worktree may be deleted from here, and why not when it may not.
 *
 * Two refusals matter. The repository's own working tree is not a worktree to
 * remove — that request is a mistake, not an intention. And a worktree with a
 * live session would be pulled out from under an agent whose cwd it is; killing
 * the session is the operation that means "and remove its worktree", and it
 * already does.
 *
 * Uncommitted work is a question rather than a refusal: the caller can say yes,
 * but has to say it.
 */
export function checkDeletable(
  wt: WorktreeInfo | undefined,
  force: boolean,
): { ok: true } | { ok: false; status: 400 | 404 | 409; error: string; dirty?: number } {
  if (!wt) return { ok: false, status: 404, error: "no such worktree" };
  if (wt.primary) {
    return { ok: false, status: 400, error: "that is the repository itself, not a worktree" };
  }
  if (wt.sessionName) {
    return {
      ok: false,
      status: 409,
      error: `${wt.session} is using this worktree — kill the session, which removes it`,
    };
  }
  if (!force && wt.dirty !== null && wt.dirty > 0) {
    return {
      ok: false,
      status: 409,
      error: `${wt.dirty} uncommitted file${wt.dirty === 1 ? "" : "s"} would be lost`,
      dirty: wt.dirty,
    };
  }
  return { ok: true };
}

/**
 * The directory AgentDock wrapped this worktree in, if it made one.
 *
 * A session's worktrees live at `<base>/.worktrees/<slug>/<repo>` so a
 * multi-repo session can keep them together — which means removing the worktree
 * empties `<slug>` but leaves it behind. Sessions with a single repo sometimes
 * sit directly at `<base>/.worktrees/<name>` and have no wrapper at all.
 *
 * Only a directory one level under AgentDock's own worktrees root counts. This
 * decides what gets removed from disk, so it says no to anything it does not
 * recognise rather than guessing.
 */
export function workspaceWrapper(path: string, basePath: string): string | null {
  const root = join(basePath, ".worktrees");
  const parent = dirname(path);
  if (parent === root) return null; /* No wrapper: the worktree is the entry. */
  if (dirname(parent) !== root) return null;
  return parent;
}

/**
 * Removes a worktree. The branch is left alone — it is where the committed work
 * is, and this is a request to free the directory, not to discard the history.
 */
export async function removeWorktree(
  repoPath: string,
  path: string,
  force: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const args = ["worktree", "remove", ...(force ? ["--force"] : []), path];
  const { ok } = await git(repoPath, args);
  /* Prune regardless: a directory deleted by hand leaves a registration behind,
     and that is exactly the row someone is trying to clear. */
  await git(repoPath, ["worktree", "prune"]);
  if (!ok && existsSync(path)) return { ok: false, error: "git refused to remove it" };

  /* git removed the worktree; the directory AgentDock put it in is ours to
     clear. Only when empty — a multi-repo session's wrapper still holds the
     other repos' worktrees, and those are not part of this request. */
  removeIfEmpty(workspaceWrapper(path, getBasePath()));
  removeIfEmpty(join(getBasePath(), ".worktrees"));
  return { ok: true };
}

function removeIfEmpty(dir: string | null): void {
  if (!dir || !existsSync(dir)) return;
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    /* Busy, or not ours to remove — leaving it is harmless. */
  }
}
