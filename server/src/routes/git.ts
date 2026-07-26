import { Hono } from "hono";
import { spawnTool } from "../services/spawn";

const app = new Hono();

interface GitStats {
  files: number;
  additions: number;
  deletions: number;
}

interface GitBranchComparison extends GitStats {
  ref: string;
  ahead: number;
  behind: number;
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawnTool("git", args, {
    cwd,
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

function parseShortStat(stdout: string): GitStats {
  const text = stdout.trim();
  if (!text) return { files: 0, additions: 0, deletions: 0 };

  const files = text.match(/(\d+)\s+files? changed/);
  const additions = text.match(/(\d+)\s+insertions?\(\+\)/);
  const deletions = text.match(/(\d+)\s+deletions?\(-\)/);

  return {
    files: files ? Number(files[1]) : 0,
    additions: additions ? Number(additions[1]) : 0,
    deletions: deletions ? Number(deletions[1]) : 0,
  };
}

function addStats(a: GitStats, b: GitStats): GitStats {
  return {
    files: a.files + b.files,
    additions: a.additions + b.additions,
    deletions: a.deletions + b.deletions,
  };
}

function parseUntrackedFiles(status: string): string[] {
  return status
    .split("\n")
    .filter((line) => line.startsWith("??"))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

async function getWorkingTreeStats(cwd: string, status: string): Promise<GitStats> {
  const tracked = await runGit(cwd, ["diff", "--shortstat", "HEAD"]);
  let stats = parseShortStat(tracked.stdout);

  const untrackedFiles = parseUntrackedFiles(status);
  if (untrackedFiles.length === 0) return stats;

  const untrackedStats = await Promise.all(
    untrackedFiles.map((file) =>
      runGit(cwd, ["diff", "--shortstat", "--no-index", "/dev/null", file])
        .then((result) => parseShortStat(result.stdout)),
    ),
  );
  for (const item of untrackedStats) {
    stats = addStats(stats, item);
  }
  return stats;
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  const result = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.exitCode === 0;
}

async function resolveBaseComparisonRef(cwd: string, upstream: { stdout: string; exitCode: number }): Promise<string | null> {
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (await refExists(cwd, ref)) return ref;
  }

  if (upstream.exitCode === 0 && upstream.stdout.trim()) {
    return upstream.stdout.trim();
  }

  return null;
}

async function getBranchComparison(cwd: string, ref: string | null): Promise<GitBranchComparison | null> {
  if (!ref) return null;

  const [counts, diff] = await Promise.all([
    runGit(cwd, ["rev-list", "--left-right", "--count", `${ref}...HEAD`]),
    runGit(cwd, ["diff", "--shortstat", `${ref}...HEAD`]),
  ]);

  if (counts.exitCode !== 0) return null;
  const [behindRaw, aheadRaw] = counts.stdout.trim().split(/\s+/);
  const stats = parseShortStat(diff.stdout);

  return {
    ref,
    ahead: Number(aheadRaw || 0),
    behind: Number(behindRaw || 0),
    ...stats,
  };
}

function parseGitLog(stdout: string): Array<{ hash: string; shortHash: string; author: string; date: string; subject: string; refs: string }> {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, author, date, subject, refs] = line.split("\x1f");
      return {
        hash: hash || "",
        shortHash: shortHash || "",
        author: author || "",
        date: date || "",
        subject: subject || "",
        refs: refs || "",
      };
    })
    .filter((commit) => commit.hash && commit.subject);
}

async function runGh(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawnTool("gh", args, {
    cwd,
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

// GET /api/git/repos?path=/Users/.../workspace
// Returns list of git repo paths under the given path (for multi-repo worktrees without metadata)
app.get("/repos", async (c) => {
  const cwd = c.req.query("path");
  if (!cwd) return c.json({ error: "path is required" }, 400);

  // Check if path itself is a git repo
  const check = await runGit(cwd, ["rev-parse", "--git-dir"]);
  if (check.exitCode === 0) {
    return c.json({ repos: [cwd] });
  }

  // Scan immediate subdirectories for git repos
  const { readdirSync, statSync } = await import("fs");
  const { join } = await import("path");
  const repos: string[] = [];
  try {
    for (const entry of readdirSync(cwd)) {
      const full = join(cwd, entry);
      try {
        if (statSync(full).isDirectory()) {
          const sub = await runGit(full, ["rev-parse", "--git-dir"]);
          if (sub.exitCode === 0) repos.push(full);
        }
      } catch {}
    }
  } catch {}
  return c.json({ repos });
});

// GET /api/git/summary?path=/Users/.../repo
app.get("/summary", async (c) => {
  const cwd = c.req.query("path");
  if (!cwd) return c.json({ error: "path is required" }, 400);

  const [status, branch, upstream] = await Promise.all([
    runGit(cwd, ["status", "--porcelain"]),
    runGit(cwd, ["branch", "--show-current"]),
    runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
  ]);

  if (status.exitCode !== 0) {
    return c.json({ error: status.stderr.trim() || "Failed to read git status" }, 400);
  }

  const comparisonRef = await resolveBaseComparisonRef(cwd, upstream);
  const [workingTree, comparison] = await Promise.all([
    getWorkingTreeStats(cwd, status.stdout),
    getBranchComparison(cwd, comparisonRef),
  ]);

  return c.json({
    branch: branch.stdout.trim() || "detached",
    upstream: upstream.exitCode === 0 ? upstream.stdout.trim() : null,
    status: status.stdout,
    workingTree,
    comparison,
  });
});

// GET /api/git/log?path=/Users/.../repo&limit=50
app.get("/log", async (c) => {
  const cwd = c.req.query("path");
  if (!cwd) return c.json({ error: "path is required" }, 400);

  const parsedLimit = parseInt(c.req.query("limit") || "50", 10);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 100)) : 50;

  const [branch, upstream, log] = await Promise.all([
    runGit(cwd, ["branch", "--show-current"]),
    runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    runGit(cwd, [
      "log",
      `--max-count=${limit}`,
      "--date=short",
      "--decorate=short",
      "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%D",
    ]),
  ]);

  if (log.exitCode !== 0) {
    return c.json({ error: log.stderr.trim() || "Failed to read git log" }, 400);
  }

  return c.json({
    branch: branch.stdout.trim() || "detached",
    upstream: upstream.exitCode === 0 ? upstream.stdout.trim() : null,
    commits: parseGitLog(log.stdout),
  });
});

// GET /api/git/changes?path=/Users/.../repo
app.get("/changes", async (c) => {
  const cwd = c.req.query("path");
  if (!cwd) return c.json({ error: "path is required" }, 400);

  const [status, diff, branch] = await Promise.all([
    runGit(cwd, ["status", "--porcelain"]),
    runGit(cwd, ["diff", "HEAD"]),
    runGit(cwd, ["branch", "--show-current"]),
  ]);

  // Generate diffs for untracked (new) files so they show up in the Changes tab
  let fullDiff = diff.stdout;
  const untrackedFiles = parseUntrackedFiles(status.stdout);
  if (untrackedFiles.length > 0) {
    const untrackedDiffs = await Promise.all(
      untrackedFiles.map((file) =>
        runGit(cwd, ["diff", "--no-index", "/dev/null", file]).then((r) => r.stdout)
      ),
    );
    fullDiff = fullDiff + untrackedDiffs.join("");
  }

  // Check if an open PR exists for this branch
  const branchName = branch.stdout.trim();
  let prUrl: string | null = null;
  if (branchName && branchName !== "main" && branchName !== "master") {
    const pr = await runGh(cwd, ["pr", "view", branchName, "--json", "url,state", "--jq", 'select(.state == "OPEN") | .url']);
    if (pr.exitCode === 0 && pr.stdout.trim()) {
      prUrl = pr.stdout.trim();
    }
  }

  return c.json({
    status: status.stdout,
    diff: fullDiff,
    branch: branchName,
    prUrl,
  });
});

// POST /api/git/create-pr
app.post("/create-pr", async (c) => {
  const body = await c.req.json() as {
    path: string;
    title: string;
    body?: string;
  };

  if (!body.path || !body.title) {
    return c.json({ error: "path and title are required" }, 400);
  }

  // Ensure changes are pushed
  const { stdout: branch } = await runGit(body.path, ["branch", "--show-current"]);
  const branchName = branch.trim();

  // Push to remote
  const push = await runGit(body.path, ["push", "-u", "origin", branchName]);
  if (push.exitCode !== 0) {
    return c.json({ error: "Failed to push to remote" }, 500);
  }

  // Create PR
  const prArgs = ["pr", "create", "--title", body.title];
  if (body.body) {
    prArgs.push("--body", body.body);
  }
  const pr = await runGh(body.path, prArgs);
  if (pr.exitCode !== 0) {
    return c.json({ error: pr.stderr || "Failed to create PR" }, 500);
  }

  // Extract PR URL from output
  const url = pr.stdout.trim();
  return c.json({ url });
});

// GET /api/git/pr-diff?path=/Users/.../repo
app.get("/pr-diff", async (c) => {
  const cwd = c.req.query("path");
  if (!cwd) return c.json({ error: "path is required" }, 400);

  const { stdout: branchRaw } = await runGit(cwd, ["branch", "--show-current"]);
  const branch = branchRaw.trim();
  if (!branch) return c.json({ error: "not on a branch" }, 400);

  const pr = await runGh(cwd, ["pr", "diff", branch]);
  if (pr.exitCode !== 0) {
    return c.json({ error: pr.stderr || "No PR found for this branch" }, 404);
  }

  return c.json({ diff: pr.stdout });
});

// POST /api/git/push
app.post("/push", async (c) => {
  const body = await c.req.json() as { path: string };
  if (!body.path) return c.json({ error: "path is required" }, 400);

  const { stdout: branch } = await runGit(body.path, ["branch", "--show-current"]);
  const branchName = branch.trim();

  const push = await runGit(body.path, ["push", "-u", "origin", branchName]);
  if (push.exitCode !== 0) {
    return c.json({ error: "Failed to push" }, 500);
  }

  return c.json({ ok: true, branch: branchName });
});

export default app;
