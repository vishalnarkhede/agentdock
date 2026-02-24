import { Hono } from "hono";
import {
  getRepos,
  addRepo,
  removeRepo,
  hasReposFile,
  getBasePath,
  setBasePath,
  getLinearApiKey,
  setLinearApiKey,
  deleteLinearApiKey,
  getLinearTeamId,
  setLinearTeamId,
  deleteLinearTeamId,
  getSlackToken,
  setSlackToken,
  deleteSlackToken,
} from "../services/config";
import type { RepoConfig } from "../types";

const app = new Hono();

// ─── Repos ───

app.get("/repos", (c) => {
  return c.json(getRepos());
});

app.post("/repos", async (c) => {
  const body = (await c.req.json()) as RepoConfig;
  if (!body.alias || !body.path) {
    return c.json({ error: "alias and path are required" }, 400);
  }
  addRepo(body);
  return c.json({ ok: true }, 201);
});

app.delete("/repos/:alias", (c) => {
  const alias = c.req.param("alias");
  removeRepo(alias);
  return c.json({ ok: true });
});

// ─── Base path ───

app.get("/base-path", (c) => {
  return c.json({ path: getBasePath() });
});

app.put("/base-path", async (c) => {
  const body = (await c.req.json()) as { path: string };
  if (!body.path) return c.json({ error: "path is required" }, 400);
  setBasePath(body.path);
  return c.json({ ok: true });
});

// ─── Integrations ───

app.get("/integrations", (c) => {
  return c.json({
    linear: {
      configured: !!getLinearApiKey(),
      hasTeamId: !!getLinearTeamId(),
    },
    slack: {
      configured: !!getSlackToken(),
    },
  });
});

app.put("/linear-key", async (c) => {
  const body = (await c.req.json()) as { key: string };
  if (!body.key) return c.json({ error: "key is required" }, 400);
  setLinearApiKey(body.key);
  return c.json({ ok: true });
});

app.delete("/linear-key", (c) => {
  deleteLinearApiKey();
  return c.json({ ok: true });
});

app.put("/linear-team-id", async (c) => {
  const body = (await c.req.json()) as { id: string };
  if (!body.id) return c.json({ error: "id is required" }, 400);
  setLinearTeamId(body.id);
  return c.json({ ok: true });
});

app.delete("/linear-team-id", (c) => {
  deleteLinearTeamId();
  return c.json({ ok: true });
});

app.put("/slack-token", async (c) => {
  const body = (await c.req.json()) as { token: string };
  if (!body.token) return c.json({ error: "token is required" }, 400);
  setSlackToken(body.token);
  return c.json({ ok: true });
});

app.delete("/slack-token", (c) => {
  deleteSlackToken();
  return c.json({ ok: true });
});

// ─── Health check ───

async function checkTool(cmd: string, args: string[]): Promise<{ installed: boolean; version: string }> {
  try {
    const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return { installed: false, version: "" };
    return { installed: true, version: stdout.trim().split("\n")[0] };
  } catch {
    return { installed: false, version: "" };
  }
}

app.get("/health", async (c) => {
  const [tmux, claude, cursor, git, gh, bun, psql] = await Promise.all([
    checkTool("tmux", ["-V"]),
    checkTool("claude", ["--version"]),
    checkTool("agent", ["--version"]),
    checkTool("git", ["--version"]),
    checkTool("gh", ["--version"]),
    checkTool("bun", ["--version"]),
    checkTool("psql", ["--version"]),
  ]);
  return c.json({ tmux, claude, cursor, git, gh, bun, psql });
});

// ─── Status (first-run detection) ───

app.get("/status", (c) => {
  const repos = getRepos();
  return c.json({
    firstRun: !hasReposFile() && repos.length > 0, // has legacy repos but no repos.json
    repoCount: repos.length,
    hasReposFile: hasReposFile(),
    linear: !!getLinearApiKey(),
    slack: !!getSlackToken(),
  });
});

export default app;
