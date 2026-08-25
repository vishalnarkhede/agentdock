import { Hono } from "hono";
import { checkDeletable, listAllWorktrees, removeWorktree } from "../services/worktrees";

const app = new Hono();

// GET /api/worktrees — every worktree git knows about, across the configured
// repos, with the session that owns it when there is one.
app.get("/", async (c) => {
  try {
    return c.json({ worktrees: await listAllWorktrees() });
  } catch (err: any) {
    return c.json({ error: err?.message || "could not list worktrees" }, 500);
  }
});

// DELETE /api/worktrees — remove one or several, by the paths they were listed
// under.
//
// Paths are checked against the live listing rather than trusted: this runs
// `git worktree remove`, and an unchecked path is an arbitrary directory.
//
// Sequential, not parallel: several removals in one repository each finish with
// `git worktree prune`, and letting those overlap is how a registry gets read
// while another process is rewriting it. A batch is a handful of directories,
// so there is nothing to gain by racing them.
app.delete("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const paths: string[] = Array.isArray(body.paths)
    ? body.paths.filter((p: unknown) => typeof p === "string" && p)
    : typeof body.path === "string" && body.path
      ? [body.path]
      : [];
  const force = body.force === true;
  if (paths.length === 0) return c.json({ error: "path is required" }, 400);

  try {
    let all = await listAllWorktrees();
    const results: { path: string; ok: boolean; error?: string }[] = [];

    for (const path of paths) {
      const wt = all.find((w) => w.path === path);
      const verdict = checkDeletable(wt, force);
      if (!verdict.ok) {
        results.push({ path, ok: false, error: verdict.error });
        continue;
      }
      const removed = await removeWorktree(wt!.repoPath, wt!.path, force);
      results.push({ path, ok: removed.ok, error: removed.error });
      /* Re-read between removals: removing one worktree can make another
         prunable, and a stale listing would then refuse it. */
      all = await listAllWorktrees();
    }

    const failed = results.filter((r) => !r.ok);
    /* One refusal in a batch is not a failed request — the rest were removed,
       and the caller needs to see which is which. */
    const status = failed.length === results.length ? 409 : 200;
    return c.json(
      {
        ok: failed.length === 0,
        results,
        error: failed.length === 1 ? failed[0].error : undefined,
        worktrees: all,
      },
      status,
    );
  } catch (err: any) {
    return c.json({ error: err?.message || "could not remove it" }, 500);
  }
});

export default app;
