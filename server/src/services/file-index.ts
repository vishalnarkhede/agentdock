import { readdir, stat } from "fs/promises";
import { watch, type FSWatcher } from "fs";
import { join, resolve } from "path";

/**
 * In-memory path index, one per root.
 *
 * The previous filename search walked the tree with readdir on every keystroke:
 * 95,197 files in the chat repo, 842ms. `git ls-files` answers the same
 * question in 19ms, and it honours .gitignore for free — so the index is cheap
 * enough to rebuild on a short TTL instead of maintaining watch-based
 * invalidation.
 */

export interface FileIndex {
  root: string;
  /** Paths relative to root. */
  paths: string[];
  /** paths[i].toLowerCase(), kept alongside so scoring never re-lowercases. */
  lower: string[];
  isGit: boolean;
  builtAt: number;
  count: number;
  truncated: boolean;
}

const WATCHED_TTL_MS = 5 * 60_000;
const FALLBACK_TTL_MS = 10_000;
const MAX_ROOTS = 6;
const WALK_CAP = 50_000;

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "__pycache__", ".cache", ".parcel-cache", "vendor", "target",
  ".turbo", "coverage", ".nyc_output", ".venv", "venv",
]);

const cache = new Map<string, FileIndex>();
const inflight = new Map<string, Promise<FileIndex>>();
const watchers = new Map<string, FSWatcher>();
const lastUsedAt = new Map<string, number>();

function watchRoot(root: string): void {
  if (watchers.has(root)) return;
  try {
    // macOS backs a recursive watcher with FSEvents, so it is dramatically
    // cheaper than walking the tree every ten seconds. On platforms that do
    // not support recursive watch this throws and the short TTL remains.
    const watcher = watch(root, { recursive: true }, () => {
      cache.delete(root);
    });
    watcher.unref();
    watcher.on("error", () => {
      watcher.close();
      watchers.delete(root);
    });
    watchers.set(root, watcher);
  } catch {
    // FALLBACK_TTL_MS keeps new files discoverable without a watcher.
  }
}

function evictOldRoots(): void {
  while (cache.size > MAX_ROOTS || watchers.size > MAX_ROOTS) {
    let oldest: string | null = null;
    const roots = new Set([...cache.keys(), ...watchers.keys()]);
    for (const root of roots) {
      if (oldest === null || (lastUsedAt.get(root) ?? 0) < (lastUsedAt.get(oldest) ?? 0)) {
        oldest = root;
      }
    }
    if (!oldest) return;
    cache.delete(oldest);
    lastUsedAt.delete(oldest);
    watchers.get(oldest)?.close();
    watchers.delete(oldest);
  }
}

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", root, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return code === 0 ? text : null;
  } catch {
    return null;
  }
}

async function isGitRoot(root: string): Promise<boolean> {
  const out = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  return out?.trim() === "true";
}

async function gitPaths(root: string): Promise<string[] | null> {
  // Untracked files are not optional here: agents create files constantly, and
  // a search that cannot find the file the agent just wrote reads as broken.
  const [tracked, untracked] = await Promise.all([
    git(root, ["ls-files", "-z"]),
    git(root, ["ls-files", "-z", "--others", "--exclude-standard"]),
  ]);
  if (tracked === null && untracked === null) return null;

  const seen = new Set<string>();
  for (const blob of [tracked, untracked]) {
    if (!blob) continue;
    for (const p of blob.split("\0")) {
      if (p) seen.add(p);
    }
  }
  return [...seen];
}

async function walkPaths(root: string): Promise<{ paths: string[]; truncated: boolean }> {
  const out: string[] = [];
  const stack: string[] = [root];
  let truncated = false;

  while (stack.length > 0) {
    if (out.length >= WALK_CAP) {
      truncated = true;
      break;
    }
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (out.length >= WALK_CAP) {
        truncated = true;
        break;
      }
      const full = join(dir, name);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        stack.push(full);
      } else {
        out.push(full.slice(root.length + 1));
      }
    }
  }
  return { paths: out, truncated };
}

async function build(root: string): Promise<FileIndex> {
  const isGit = await isGitRoot(root);
  let paths: string[];
  let truncated = false;

  if (isGit) {
    const p = await gitPaths(root);
    if (p) {
      paths = p;
    } else {
      const w = await walkPaths(root);
      paths = w.paths;
      truncated = w.truncated;
    }
  } else {
    const w = await walkPaths(root);
    paths = w.paths;
    truncated = w.truncated;
  }

  paths.sort();
  return {
    root,
    paths,
    lower: paths.map((p) => p.toLowerCase()),
    isGit,
    builtAt: Date.now(),
    count: paths.length,
    truncated,
  };
}

/**
 * The index for `root`, rebuilt when older than the TTL. Roots are keyed by the
 * path actually passed — usually a worktree such as
 * ~/projects/.worktrees/wt-abc123/chat, not the repo it came from.
 */
export async function getIndex(root: string): Promise<FileIndex> {
  const key = resolve(root);
  lastUsedAt.set(key, Date.now());
  const hit = cache.get(key);
  const ttl = watchers.has(key) ? WATCHED_TTL_MS : FALLBACK_TTL_MS;
  if (hit && Date.now() - hit.builtAt < ttl) return hit;

  const pending = inflight.get(key);
  if (pending) return pending;

  const task = build(key)
    .then((idx) => {
      cache.set(key, idx);
      watchRoot(key);
      evictOldRoots();
      return idx;
    })
    .catch((err) => {
      if (hit) return hit;
      throw err;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, task);
  return task;
}

export function invalidate(root?: string): void {
  if (root) {
    cache.delete(resolve(root));
  } else {
    cache.clear();
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    lastUsedAt.clear();
  }
}

export function peek(root: string): FileIndex | undefined {
  return cache.get(resolve(root));
}
