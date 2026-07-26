import { existsSync, readdirSync, rmdirSync } from "fs";
import { basename, dirname } from "path";
import type {
  CreateRepoWorktreeRequest,
  DeleteRepoWorktreeRequest,
  RepoBranchesResponse,
  RepoBranchInfo,
  RepoConfig,
  RepoWorktreeCreated,
  RepoWorktreeDeleted,
  RepoWorktreeInfo,
} from "../types";
import { addRepo, getAllSessionMetas, getRepos, removeRepo, PREFIX } from "./config";
import { spawnTool } from "./spawn";
import { branchExists, createWorktree, getSourceRepoPath, worktreePath } from "./worktree";

interface ParsedWorktree {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
}

async function runGit(
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

function parseWorktreeList(output: string): ParsedWorktree[] {
  const result: ParsedWorktree[] = [];
  let current: ParsedWorktree | null = null;

  const finish = () => {
    if (current?.path) result.push(current);
    current = null;
  };

  for (const line of output.split("\n")) {
    if (!line.trim()) {
      finish();
      continue;
    }
    if (line.startsWith("worktree ")) {
      finish();
      current = { path: line.slice("worktree ".length), bare: false };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current && line === "bare") {
      current.bare = true;
    } else if (current && line === "detached") {
      current.branch = "detached";
    }
  }
  finish();

  return result;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/^[^/]+\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function suggestedAlias(
  repo: RepoConfig,
  wt: ParsedWorktree,
  configuredByPath: Map<string, RepoConfig>,
  usedAliases: Set<string>,
): string {
  const configured = configuredByPath.get(wt.path);
  if (configured) return configured.alias;

  const suffix = slugify(wt.branch || basename(wt.path)) || "worktree";
  const base = slugify(`${repo.alias}-${suffix}`) || slugify(`${basename(repo.path)}-${suffix}`) || suffix;
  let candidate = base;
  let i = 2;
  while (usedAliases.has(candidate)) {
    candidate = `${base}-${i}`;
    i += 1;
  }
  usedAliases.add(candidate);
  return candidate;
}

/**
 * Worktrees Agentdock created for a running agent, keyed by path.
 *
 * These are deleted when the agent stops, so offering to import them into repos.json
 * would register an alias pointing at a directory that is about to disappear. They
 * are only distinguishable from a hand-made worktree by this metadata — on disk they
 * look identical.
 */
function agentOwnedWorktrees(): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [sessionName, metas] of Object.entries(getAllSessionMetas())) {
    for (const meta of metas) {
      if (!meta.managed) continue;
      owners.set(meta.wtDir, sessionName.replace(new RegExp(`^${PREFIX}-`), ""));
    }
  }
  return owners;
}

export async function discoverRepoWorktrees(): Promise<RepoWorktreeInfo[]> {
  const repos = getRepos();
  const configuredByPath = new Map(repos.map((repo) => [repo.path, repo]));
  const configuredAliases = new Set(repos.map((repo) => repo.alias));
  const agentOwned = agentOwnedWorktrees();
  const byPath = new Map<string, RepoWorktreeInfo>();

  for (const repo of repos) {
    if (!existsSync(repo.path)) continue;

    let listed: ParsedWorktree[] = [];
    try {
      const result = await runGit(repo.path, ["worktree", "list", "--porcelain"]);
      if (result.exitCode !== 0) continue;
      listed = parseWorktreeList(result.stdout);
    } catch {
      continue;
    }

    const primaryPath = listed[0]?.path;
    for (const wt of listed) {
      if (byPath.has(wt.path)) continue;
      const configured = configuredByPath.has(wt.path);
      const alias = suggestedAlias(repo, wt, configuredByPath, configuredAliases);
      byPath.set(wt.path, {
        repoAlias: repo.alias,
        repoPath: repo.path,
        path: wt.path,
        branch: wt.branch,
        head: wt.head,
        bare: wt.bare,
        isMain: wt.path === primaryPath,
        configured,
        suggestedAlias: alias,
        remote: repo.remote,
        agentSession: agentOwned.get(wt.path),
      });
    }
  }

  return [...byPath.values()].sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? 1 : -1;
    return a.path.localeCompare(b.path);
  });
}

function requireRepo(alias: string): RepoConfig {
  const repo = getRepos().find((r) => r.alias === alias);
  if (!repo) throw new Error(`Unknown repo '${alias}'`);
  if (!existsSync(repo.path)) throw new Error(`Repo path no longer exists: ${repo.path}`);
  return repo;
}

/** Branch name → path of the worktree that currently has it checked out. */
async function checkedOutBranches(sourceRepoPath: string): Promise<Map<string, string>> {
  const checkedOut = new Map<string, string>();
  const result = await runGit(sourceRepoPath, ["worktree", "list", "--porcelain"]);
  if (result.exitCode !== 0) return checkedOut;
  for (const wt of parseWorktreeList(result.stdout)) {
    if (wt.branch && wt.branch !== "detached") checkedOut.set(wt.branch, wt.path);
  }
  return checkedOut;
}

async function listRefs(repoPath: string, pattern: string, format = "%(refname:short)"): Promise<string[]> {
  const result = await runGit(repoPath, ["for-each-ref", `--format=${format}`, pattern]);
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Remote-tracking ref for a branch with no local counterpart, preferring origin. */
async function findRemoteRef(repoPath: string, branch: string): Promise<string | undefined> {
  const refs = await listRefs(repoPath, `refs/remotes/*/${branch}`);
  return refs.find((ref) => ref.startsWith("origin/")) || refs[0];
}

export async function listRepoBranches(repoAlias: string): Promise<RepoBranchesResponse> {
  const repo = requireRepo(repoAlias);
  const sourceRepoPath = await getSourceRepoPath(repo.path);

  const [checkedOut, locals, remotes] = await Promise.all([
    checkedOutBranches(sourceRepoPath),
    listRefs(sourceRepoPath, "refs/heads"),
    // Full refnames, not short ones: refs/remotes/origin/HEAD shortens to plain
    // "origin", which is indistinguishable from a branch actually named "origin".
    listRefs(sourceRepoPath, "refs/remotes", "%(refname)"),
  ]);

  const branches: RepoBranchInfo[] = locals
    .slice()
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, remote: false, worktreePath: checkedOut.get(name) }));

  // origin first, so a branch carried by several remotes is offered as the origin one.
  // findRemoteRef() resolves the same name to origin when the worktree is created, and
  // the two disagreeing would list `fork/x` while silently checking out `origin/x`.
  const byOriginFirst = (a: string, b: string) => {
    const rank = (ref: string) => (ref.startsWith("refs/remotes/origin/") ? 0 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  };

  const seen = new Set(locals);
  for (const fullRef of remotes.slice().sort(byOriginFirst)) {
    // origin/HEAD is a symbolic pointer at the default branch, not a branch of its own.
    if (fullRef.endsWith("/HEAD")) continue;
    const ref = fullRef.replace(/^refs\/remotes\//, "");
    const name = ref.replace(/^[^/]+\//, "");
    if (!name || name === ref || seen.has(name)) continue;
    seen.add(name);
    branches.push({ name, remote: true, ref });
  }

  const head = await runGit(sourceRepoPath, ["branch", "--show-current"]);
  const defaultBase =
    (locals.includes("main") && "main") ||
    (locals.includes("master") && "master") ||
    head.stdout.trim() ||
    locals[0] ||
    "HEAD";

  return { branches, defaultBase };
}

/**
 * Create a worktree for an existing or brand-new branch and register it in repos.json
 * so it shows up as a linked worktree.
 *
 * Everything that can be checked without touching disk is checked first — a failure
 * partway through would leave an orphaned worktree with no alias pointing at it.
 */
export async function createRepoWorktree(
  input: CreateRepoWorktreeRequest,
): Promise<RepoWorktreeCreated> {
  const repo = requireRepo(input.repoAlias);
  const branch = input.branch.trim();
  if (!branch) throw new Error("branch is required");

  const nameCheck = await runGit(repo.path, ["check-ref-format", "--branch", branch]);
  if (nameCheck.exitCode !== 0) throw new Error(`'${branch}' is not a valid branch name`);

  const sourceRepoPath = await getSourceRepoPath(repo.path);
  const existsLocally = await branchExists(sourceRepoPath, branch);

  let base = input.base?.trim() || undefined;
  if (input.createBranch) {
    if (existsLocally) throw new Error(`Branch '${branch}' already exists`);
  } else if (!existsLocally) {
    // Existing-branch mode with no local branch is only valid when a remote has it.
    // Branching off the remote ref makes the new local branch track it.
    const remoteRef = await findRemoteRef(sourceRepoPath, branch);
    if (!remoteRef) throw new Error(`Branch '${branch}' not found`);
    base = remoteRef;
  }

  const busy = (await checkedOutBranches(sourceRepoPath)).get(branch);
  if (busy) throw new Error(`Branch '${branch}' is already checked out at ${busy}`);

  const wtDir = worktreePath(sourceRepoPath, branch);
  if (existsSync(wtDir)) throw new Error(`A directory already exists at ${wtDir}`);

  const configured = getRepos();
  const explicitAlias = input.alias?.trim();
  if (explicitAlias && configured.some((r) => r.alias === explicitAlias)) {
    throw new Error(`Alias '${explicitAlias}' is already in use`);
  }
  const alias =
    explicitAlias ||
    suggestedAlias(
      repo,
      { path: wtDir, branch, bare: false },
      new Map(),
      new Set(configured.map((r) => r.alias)),
    );

  const path = await createWorktree(repo.path, branch, base);
  addRepo({ alias, path, remote: repo.remote });
  return { path, alias, branch };
}

/** Uncommitted work would be lost by the delete; the caller may re-try with force. */
export class WorktreeDirtyError extends Error {
  constructor(public readonly changes: number) {
    super(`Worktree has ${changes} uncommitted change${changes !== 1 ? "s" : ""}`);
    this.name = "WorktreeDirtyError";
  }
}

/** The branch holds commits that exist nowhere else; the caller may re-try with forceBranch. */
export class BranchUnmergedError extends Error {
  constructor(public readonly branch: string) {
    super(`Branch '${branch}' is not merged into HEAD and not fully pushed`);
    this.name = "BranchUnmergedError";
  }
}

/**
 * Whether deleting the branch would discard commits: safe if it is an ancestor of
 * the repo's HEAD (already merged) or fully pushed to its upstream (recoverable
 * from the remote). This mirrors what `git branch -d` accepts, which we can't
 * simply run to find out — it always refuses while the branch is checked out.
 */
async function branchIsSafeToDelete(repoPath: string, branch: string): Promise<boolean> {
  const merged = await runGit(repoPath, ["merge-base", "--is-ancestor", branch, "HEAD"]);
  if (merged.exitCode === 0) return true;

  const upstream = await runGit(repoPath, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
  if (upstream.exitCode !== 0) return false;
  const ahead = await runGit(repoPath, ["rev-list", "--count", `${upstream.stdout.trim()}..${branch}`]);
  return ahead.exitCode === 0 && ahead.stdout.trim() === "0";
}

/**
 * Delete a worktree's checkout from disk and drop its alias.
 *
 * The branch is deliberately left alone: it lives in the parent repo, not in the
 * worktree, so every commit made here survives. That makes uncommitted work the
 * only thing a delete can destroy — hence the dirty check rather than any attempt
 * to reason about unpushed commits, which are never at risk.
 */
export async function deleteRepoWorktree(
  input: DeleteRepoWorktreeRequest,
): Promise<RepoWorktreeDeleted> {
  const target = input.path;
  const worktree = (await discoverRepoWorktrees()).find((wt) => wt.path === target);
  if (!worktree) throw new Error(`Not a known worktree: ${target}`);
  if (worktree.isMain) throw new Error("Refusing to delete the repo's main checkout");
  if (worktree.agentSession) {
    throw new Error(
      `Worktree belongs to agent '${worktree.agentSession}' and is removed when that agent stops`,
    );
  }

  const branch = worktree.branch && worktree.branch !== "detached" ? worktree.branch : undefined;
  const deleteBranch = Boolean(input.deleteBranch && branch);

  // Both destructive checks run before anything is removed. Deleting the worktree
  // first and only then discovering the branch is unmerged would leave the caller
  // unable to back out of a decision it had not finished making.
  if (!input.force && existsSync(target)) {
    const status = await runGit(target, ["status", "--porcelain"]);
    const changes = status.stdout.split("\n").filter(Boolean).length;
    if (changes > 0) throw new WorktreeDirtyError(changes);
  }
  if (deleteBranch && !input.forceBranch) {
    if (!(await branchIsSafeToDelete(worktree.repoPath, branch!))) {
      throw new BranchUnmergedError(branch!);
    }
  }

  if (existsSync(target)) {
    const args = ["worktree", "remove", ...(input.force ? ["--force"] : []), target];
    const result = await runGit(worktree.repoPath, args);
    if (result.exitCode !== 0 && existsSync(target)) {
      throw new Error(result.stderr.trim() || `Failed to remove worktree at ${target}`);
    }
  }
  // Also clears the registry entry when the directory was already gone by hand.
  await runGit(worktree.repoPath, ["worktree", "prune"]);

  // Only after the worktree is gone, since git refuses to delete a checked-out branch.
  let branchDeleted = false;
  if (deleteBranch) {
    const result = await runGit(worktree.repoPath, [
      "branch",
      input.forceBranch ? "-D" : "-d",
      branch!,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `Worktree deleted, but branch '${branch}' could not be: ${result.stderr.trim()}`,
      );
    }
    branchDeleted = true;
  }

  const configured = getRepos().find((repo) => repo.path === target);
  if (configured) removeRepo(configured.alias);

  pruneEmptyWorktreesDir(dirname(target));

  return { path: target, alias: configured?.alias, branch, branchDeleted };
}

/** Drop the per-repo container once its last worktree is gone, so it doesn't linger empty. */
function pruneEmptyWorktreesDir(dir: string): void {
  if (!basename(dir).endsWith("__worktrees")) return;
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // best effort
  }
}
