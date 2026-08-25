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

// DELETE /api/worktrees — remove one, by the path it was listed under.
//
// The path is checked against the live listing rather than trusted: this runs
// `git worktree remove`, and an unchecked path is an arbitrary directory.
app.delete("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const path = typeof body.path === "string" ? body.path : "";
  const force = body.force === true;
  if (!path) return c.json({ error: "path is required" }, 400);

  try {
    const all = await listAllWorktrees();
    const wt = all.find((w) => w.path === path);
    const verdict = checkDeletable(wt, force);
    if (!verdict.ok) {
      return c.json({ error: verdict.error, dirty: verdict.dirty }, verdict.status);
    }
    const result = await removeWorktree(wt!.repoPath, wt!.path, force);
    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json({ ok: true, worktrees: await listAllWorktrees() });
  } catch (err: any) {
    return c.json({ error: err?.message || "could not remove it" }, 500);
  }
});

export default app;
