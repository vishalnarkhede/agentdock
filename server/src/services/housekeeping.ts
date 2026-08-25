/**
 * Housekeeping — the disk nobody is counting.
 *
 * Worktrees are cheap to make and easy to forget. Nothing else in AgentDock
 * looks at what a session left behind, so a machine accumulates directories
 * whose branches are already in main, `wt-*` branches whose sessions were
 * killed rather than shipped, and fresh worktrees that will burn their first
 * two minutes on an install.
 *
 * This module reports those facts and nothing else. It removes nothing.
 *
 * Every git call runs from the main repo with `-C`, never with a `cwd` inside
 * a worktree: a worktree directory can be deleted while git still lists it,
 * and spawning into a missing cwd throws ENOENT naming `git`, which reads like
 * git is missing rather than the directory.
 */

import { existsSync, statSync } from "fs";
import { join, resolve } from "path";
import type { RepoConfig } from "../types";

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface WorktreeRecord {
  /** Absolute path git reported. The directory may no longer exist. */
  path: string;
  /** Commit sha. Absent on a bare record, which carries no HEAD line. */
  head?: string;
  /** Short branch name, e.g. "wt-3f9a". Absent when detached or bare. */
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockedReason?: string;
  prunable: boolean;
  prunableReason?: string;
}

export interface WorktreeFact {
  /** Repo alias this worktree belongs to. */
  repo: string;
  path: string;
  branch: string | null;
  /** Directory size on disk. -1 when not measured. */
  bytes: number;
  locked: boolean;
  /** git lists it but the directory is gone. */
  missing: boolean;
}

export interface BranchFact {
  repo: string;
  branch: string;
}

export interface RepoScan {
  alias: string;
  path: string;
  /** The ref everything was compared against, or null if none could be found. */
  defaultRef: string | null;
  error?: string;
}

export interface HousekeepingReport {
  repos: RepoScan[];
  /** Worktrees whose branch is already contained in the default ref. */
  mergedWorktrees: WorktreeFact[];
  /** Worktrees carrying commits the default ref does not have. */
  unmergedWorktrees: WorktreeFact[];
  /** Registered with git, but the directory is no longer on disk. */
  missingWorktrees: WorktreeFact[];
  /** `wt-*` branches fully contained in the default ref and not checked out. */
  staleBranches: BranchFact[];
  /** Worktrees with a package.json but no node_modules. */
  missingInstall: WorktreeFact[];
  /** Sum of the merged worktrees' sizes — what removing them would free. */
  reclaimableBytes: number;
  counts: {
    repos: number;
    scanErrors: number;
    merged: number;
    unmerged: number;
    missing: number;
    staleBranches: number;
    missingInstall: number;
  };
  scannedAt: string;
}

/* ── Pure parsing ────────────────────────────────────────────────────────── */

/**
 * Parse `git worktree list --porcelain`.
 *
 * Records are separated by blank lines. The first record is always the main
 * working tree. Every line is `key` or `key value`; a path may contain spaces,
 * so the value is everything after the first space rather than the second
 * field. `bare` records carry no HEAD line at all, and `locked`/`prunable`
 * appear with or without a reason depending on the git version.
 */
export function parseWorktreeList(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | null = null;

  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") {
      if (current) records.push(current);
      current = null;
      continue;
    }
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "" : line.slice(space + 1);

    if (key === "worktree") {
      if (current) records.push(current);
      current = { path: value, detached: false, bare: false, locked: false, prunable: false };
      continue;
    }
    if (!current) continue;

    if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
    else if (key === "locked") {
      current.locked = true;
      if (value) current.lockedReason = value;
    } else if (key === "prunable") {
      current.prunable = true;
      if (value) current.prunableReason = value;
    }
  }
  if (current) records.push(current);
  return records;
}

/** A branch created by a session rather than by a person. */
export function isSessionBranch(branch: string): boolean {
  return /^wt-/.test(branch);
}

/**
 * Split branch names three ways.
 *
 * A branch checked out by a live worktree is never stale, however merged it
 * looks — reporting an active session's branch as safe to delete is worse
 * than omitting it.
 */
export function classifyBranches(
  branches: string[],
  merged: Iterable<string>,
  checkedOut: Iterable<string>,
): { stale: string[]; unmerged: string[]; inUse: string[] } {
  const mergedSet = new Set(merged);
  const busy = new Set(checkedOut);
  const stale: string[] = [];
  const unmerged: string[] = [];
  const inUse: string[] = [];
  for (const b of branches) {
    if (busy.has(b)) inUse.push(b);
    else if (mergedSet.has(b)) stale.push(b);
    else unmerged.push(b);
  }
  return { stale, unmerged, inUse };
}

/** First field of `du -sk` output, in bytes. -1 when unparseable. */
export function parseDuKilobytes(output: string): number {
  const m = /^\s*(\d+)/.exec(output);
  return m ? Number(m[1]) * 1024 : -1;
}

/** `refname:short` lines, blank-safe. */
export function parseRefLines(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== "HEAD");
}

/* ── Filesystem and git ──────────────────────────────────────────────────── */

/** Spawning can throw before git ever runs. Treat that as a failed command. */
async function runGit(
  repoPath: string,
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  try {
    const proc = Bun.spawn(["git", "-C", repoPath, ...args], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { stdout, exitCode };
  } catch {
    return { stdout: "", exitCode: 128 };
  }
}

/** git's registry outlives the directory it points at. */
export function directoryExists(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A worktree with dependencies declared but never installed. existsSync
 * follows symlinks, which is what we want: worktree creation symlinks
 * node_modules from the main repo, so a working link reads as installed and
 * a broken one reads as missing.
 */
export function needsInstall(dir: string): boolean {
  if (!directoryExists(dir)) return false;
  return existsSync(join(dir, "package.json")) && !existsSync(join(dir, "node_modules"));
}

/** Apparent size on disk. No -L: a symlinked node_modules is not ours to free. */
export async function directorySize(dir: string): Promise<number> {
  if (!directoryExists(dir)) return 0;
  try {
    const proc = Bun.spawn(["du", "-sk", dir], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return parseDuKilobytes(stdout);
  } catch {
    return -1;
  }
}

/** The ref a branch should be measured against, preferring the remote's head. */
export async function resolveDefaultRef(repoPath: string): Promise<string | null> {
  const head = await runGit(repoPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.exitCode === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    const r = await runGit(repoPath, ["rev-parse", "--verify", "--quiet", ref]);
    if (r.exitCode === 0 && r.stdout.trim()) return ref;
  }
  return null;
}

export async function listWorktrees(repoPath: string): Promise<WorktreeRecord[]> {
  const r = await runGit(repoPath, ["worktree", "list", "--porcelain"]);
  if (r.exitCode !== 0) return [];
  return parseWorktreeList(r.stdout);
}

/** Local branches whose tip the default ref already contains. */
async function mergedBranches(repoPath: string, defaultRef: string): Promise<string[]> {
  const r = await runGit(repoPath, ["branch", "--merged", defaultRef, "--format=%(refname:short)"]);
  if (r.exitCode !== 0) return [];
  return parseRefLines(r.stdout);
}

async function localBranches(repoPath: string): Promise<string[]> {
  const r = await runGit(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  if (r.exitCode !== 0) return [];
  return parseRefLines(r.stdout);
}

/** Is `rev` already contained in `ref`? Used for detached worktrees. */
async function isAncestor(repoPath: string, rev: string, ref: string): Promise<boolean> {
  const r = await runGit(repoPath, ["merge-base", "--is-ancestor", rev, ref]);
  return r.exitCode === 0;
}

/* ── Scan ────────────────────────────────────────────────────────────────── */

interface RepoResult {
  scan: RepoScan;
  merged: WorktreeFact[];
  unmerged: WorktreeFact[];
  missing: WorktreeFact[];
  staleBranches: BranchFact[];
  missingInstall: WorktreeFact[];
}

const emptyResult = (scan: RepoScan): RepoResult => ({
  scan,
  merged: [],
  unmerged: [],
  missing: [],
  staleBranches: [],
  missingInstall: [],
});

/**
 * Everything one repo has left lying around.
 *
 * The main working tree is excluded from every count: its branch is
 * trivially contained in the default ref, so including it would offer the
 * repo itself up for removal and let its size dominate the reclaimable
 * figure.
 */
export async function scanRepo(repo: RepoConfig): Promise<RepoResult> {
  const repoPath = resolve(repo.path);
  const scan: RepoScan = { alias: repo.alias, path: repoPath, defaultRef: null };

  if (!directoryExists(repoPath)) {
    return emptyResult({ ...scan, error: "repo directory not found" });
  }
  const inside = await runGit(repoPath, ["rev-parse", "--git-dir"]);
  if (inside.exitCode !== 0) {
    return emptyResult({ ...scan, error: "not a git repository" });
  }

  const defaultRef = await resolveDefaultRef(repoPath);
  scan.defaultRef = defaultRef;

  const records = await listWorktrees(repoPath);
  const linked = records.filter((w) => !w.bare && resolve(w.path) !== repoPath);
  const checkedOut = records.map((w) => w.branch).filter((b): b is string => !!b);

  const result = emptyResult(scan);

  const merged = defaultRef ? await mergedBranches(repoPath, defaultRef) : [];
  const mergedSet = new Set(merged);

  if (defaultRef) {
    const candidates = (await localBranches(repoPath)).filter(isSessionBranch);
    const { stale } = classifyBranches(candidates, merged, checkedOut);
    result.staleBranches = stale.map((branch) => ({ repo: repo.alias, branch }));
  }

  // Sizes are deliberately not measured here — `du` is by far the most
  // expensive part of the scan, so scanRepos measures once, for the merged
  // worktrees only, under a concurrency limit.
  const classified = await Promise.all(
    linked.map(async (w) => {
      const path = resolve(w.path);
      const fact: WorktreeFact = {
        repo: repo.alias,
        path,
        branch: w.branch ?? null,
        bytes: 0,
        locked: w.locked,
        missing: false,
      };

      if (!directoryExists(path)) {
        return { fact: { ...fact, missing: true }, bucket: "missing" as const, install: false };
      }
      const install = needsInstall(path);

      let contained = false;
      if (defaultRef) {
        contained = w.branch
          ? mergedSet.has(w.branch)
          : w.head
            ? await isAncestor(repoPath, w.head, defaultRef)
            : false;
      }
      return { fact, bucket: contained ? ("merged" as const) : ("unmerged" as const), install };
    }),
  );

  for (const { fact, bucket, install } of classified) {
    if (bucket === "missing") result.missing.push(fact);
    else if (bucket === "merged") result.merged.push(fact);
    else result.unmerged.push(fact);
    if (install) result.missingInstall.push(fact);
  }

  return result;
}

/**
 * A worktree's size costs a full directory walk, so a machine with dozens of
 * repos can spend minutes here if every `du` runs at once or none do. Fill
 * the sizes in place, a few at a time.
 */
async function measureSizes(facts: WorktreeFact[], limit = 8): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < facts.length) {
      const fact = facts[next++];
      fact.bytes = await directorySize(fact.path);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, facts.length) }, worker));
}

/**
 * Scan every repo. One unreadable repo reports an error against itself rather
 * than failing the whole report.
 *
 * Cost is O(worktrees) git calls plus a `du` per merged worktree, so this can
 * take seconds on a machine with many repos. Nothing is cached.
 */
export async function scanRepos(repos: RepoConfig[]): Promise<HousekeepingReport> {
  const results = await Promise.all(
    repos.map(async (repo) => {
      try {
        return await scanRepo(repo);
      } catch (e) {
        return emptyResult({
          alias: repo.alias,
          path: repo.path,
          defaultRef: null,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }),
  );

  const merged = results.flatMap((r) => r.merged);
  await measureSizes(merged);

  const unmerged = results.flatMap((r) => r.unmerged);
  const missing = results.flatMap((r) => r.missing);
  const staleBranches = results.flatMap((r) => r.staleBranches);
  const missingInstall = results.flatMap((r) => r.missingInstall);
  const scans = results.map((r) => r.scan);

  return {
    repos: scans,
    mergedWorktrees: merged,
    unmergedWorktrees: unmerged,
    missingWorktrees: missing,
    staleBranches,
    missingInstall,
    reclaimableBytes: merged.reduce((n, w) => n + Math.max(0, w.bytes), 0),
    counts: {
      repos: scans.length,
      scanErrors: scans.filter((s) => s.error).length,
      merged: merged.length,
      unmerged: unmerged.length,
      missing: missing.length,
      staleBranches: staleBranches.length,
      missingInstall: missingInstall.length,
    },
    scannedAt: new Date().toISOString(),
  };
}
