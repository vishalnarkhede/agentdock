import { Hono } from "hono";
import { getRepos } from "../services/config";
import { scanRepos } from "../services/housekeeping";

const app = new Hono();

/**
 * GET /api/housekeeping — what the sessions left behind.
 *
 * Read-only by design. Removing a worktree or deleting a branch is
 * destructive and irreversible from a dashboard, so this endpoint reports
 * the facts and offers no action to act on them.
 */
app.get("/", async (c) => {
  const repos = getRepos();
  try {
    return c.json(await scanRepos(repos));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

export default app;
