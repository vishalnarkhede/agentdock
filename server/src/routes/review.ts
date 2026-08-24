import { Hono } from "hono";
import { existsSync, statSync } from "fs";
import { getPlan, getAllSessionMetas } from "../services/config";
import { parsePlanSteps, parseNumstat } from "../services/review-stats";
import { findConflicts, unionPaths } from "../services/conflicts";

const app = new Hono();

/**
 * A worktree directory can be deleted while its session metadata survives, and
 * spawning with a cwd that no longer exists throws ENOENT naming `git` — which
 * reads like git is missing rather than the directory. Treat it as a failed
 * command so one stale worktree cannot take down a whole scan.
 */
async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { stdout, exitCode };
  } catch {
    return { stdout: "", exitCode: 128 };
  }
}

/** Session metadata outlives the directory it points at. */
function worktreeExists(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Changed files with line counts, tracked and untracked, prefixed per repo. */
async function changedFiles(paths: string[]): Promise<{ path: string; plus: number; minus: number }[]> {
  const multi = paths.length > 1;
  const perRepo = await Promise.all(
    paths.map(async (cwd) => {
      const label = multi ? `${cwd.split("/").filter(Boolean).pop()}/` : "";
      const [tracked, others] = await Promise.all([
        runGit(cwd, ["diff", "--numstat", "HEAD"]),
        // `status --porcelain` collapses an untracked directory to "sub/", and
        // `diff --no-index /dev/null sub/` then fails — so a whole new folder
        // was being recorded as one zero-line file. ls-files never collapses.
        runGit(cwd, ["ls-files", "--others", "--exclude-standard"]),
      ]);
      const files = parseNumstat(tracked.stdout);

      // Untracked files carry no diff against HEAD, so count them separately.
      const untracked = others.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const extra = await Promise.all(
        untracked.map(async (f) => {
          const r = await runGit(cwd, ["diff", "--no-index", "--numstat", "/dev/null", f]);
          const parsed = parseNumstat(r.stdout);
          return parsed[0] ?? { path: f, plus: 0, minus: 0 };
        }),
      );

      return [...files, ...extra].map((f) => ({ ...f, path: label + f.path }));
    }),
  );
  return perRepo.flat();
}

/**
 * Resolve the branch's base, preferring the remote's default head. Returns null
 * when there is nothing sensible to diff against (a detached or rootless repo).
 */
async function mergeBase(cwd: string): Promise<string | null> {
  const head = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const candidates = [
    head.exitCode === 0 ? head.stdout.trim() : "",
    "origin/main",
    "origin/master",
    "main",
    "master",
  ].filter(Boolean);
  for (const ref of candidates) {
    const r = await runGit(cwd, ["merge-base", "HEAD", ref]);
    if (r.exitCode === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

/** Every path this branch would bring to a merge — committed and not. */
async function branchPaths(cwd: string): Promise<string[]> {
  const base = await mergeBase(cwd);
  const [committed, uncommitted, others] = await Promise.all([
    base ? runGit(cwd, ["diff", "--numstat", `${base}...HEAD`]) : Promise.resolve({ stdout: "", exitCode: 0 }),
    runGit(cwd, ["diff", "--numstat", "HEAD"]),
    runGit(cwd, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  const untracked = others.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return unionPaths(
    parseNumstat(committed.stdout).map((f) => f.path),
    parseNumstat(uncommitted.stdout).map((f) => f.path),
    untracked,
  );
}

// GET /api/review/summary?session=<name>&path=<repo>&path=<repo>
//
// The counts the Plan and Changes surfaces put in their headers: how much of
// the plan is ticked off, and how big the diff is. This replaced /coverage,
// which also guessed which plan step each changed file belonged to — that guess
// was the Coverage tab, and the tab is gone.
app.get("/summary", async (c) => {
  const session = c.req.query("session");
  const paths = c.req.queries("path")?.filter(Boolean) ?? [];
  if (paths.length === 0) return c.json({ error: "at least one path is required" }, 400);

  try {
    const [plan, files] = await Promise.all([
      Promise.resolve(session ? getPlan(session) : null),
      changedFiles(paths),
    ]);
    const steps = plan ? parsePlanSteps(plan) : [];
    return c.json({
      plan: { total: steps.length, done: steps.filter((s) => s.done).length },
      diff: {
        files: files.length,
        plus: files.reduce((n, f) => n + f.plus, 0),
        minus: files.reduce((n, f) => n + f.minus, 0),
      },
      hasPlan: plan !== null,
    });
  } catch (err: any) {
    return c.json({ error: err?.message || "summary failed" }, 500);
  }
});

// GET /api/review/conflicts
//
// Which sessions are about to collide. Two worktrees editing the same file is
// the standard failure of running agents in parallel, and it stays invisible
// until the second merge — by which point you are resolving it under pressure.
app.get("/conflicts", async (c) => {
  try {
    const metas = getAllSessionMetas();
    const entries = await Promise.all(
      Object.entries(metas)
        .map(([session, wts]) => [session, wts.filter((wt) => worktreeExists(wt.wtDir))] as const)
        .filter(([, wts]) => wts.length > 0)
        .map(async ([session, wts]) => {
          // Compare by repo-relative path so the same file in two worktrees matches.
          const perRepo = await Promise.all(
            wts.map(async (wt) => {
              // Branch-vs-base, not working-tree: a session that already
              // committed still brings all of it to the merge.
              const paths = await branchPaths(wt.wtDir);
              const repo = wt.repoPath.split("/").filter(Boolean).pop() || "repo";
              return paths.map((p) => `${repo}/${p}`);
            }),
          );
          return { session: session.replace(/^claude-/, ""), files: perRepo.flat() };
        }),
    );
    const withChanges = entries.filter((e) => e.files.length > 0);
    return c.json({
      conflicts: findConflicts(withChanges),
      worktrees: withChanges.map((e) => ({ session: e.session, fileCount: e.files.length })),
    });
  } catch (err: any) {
    return c.json({ error: err?.message || "conflict scan failed" }, 500);
  }
});

export default app;
