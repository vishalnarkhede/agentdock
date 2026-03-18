import { Hono } from "hono";

const app = new Hono();

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

async function runGh(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["gh", ...args], {
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
  const untrackedFiles = status.stdout
    .split("\n")
    .filter((line) => line.startsWith("??"))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
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
