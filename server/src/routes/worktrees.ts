import { Hono } from "hono";
import { listAllWorktrees } from "../services/worktrees";

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

export default app;
