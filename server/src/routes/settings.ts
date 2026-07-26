import { Hono } from "hono";
import {
  getRepos,
  addRepo,
  removeRepo,
  hasReposFile,
  hasBasePath,
  getBasePath,
  setBasePath,
  getCustomActions,
  saveCustomAction,
  deleteCustomAction,
  scanBasePath,
  getMcpServers,
  addMcpServer,
  removeMcpServer,
  getPreferences,
  savePreferences,
  getMetaPropertyPresets,
  saveMetaPropertyPresets,
  getNgrokBasicAuth,
  setNgrokBasicAuth,
  deleteNgrokBasicAuth,
} from "../services/config";
import type {
  CreateRepoWorktreeRequest,
  DeleteRepoWorktreeRequest,
  RepoConfig,
} from "../types";
import {
  createRepoWorktree,
  deleteRepoWorktree,
  discoverRepoWorktrees,
  listRepoBranches,
  BranchUnmergedError,
  WorktreeDirtyError,
} from "../services/repo-worktrees";
import { spawnTool } from "../services/spawn";

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

// Must stay above DELETE /repos/:alias — Hono matches in registration order, so the
// parameterized route would otherwise swallow this as alias="worktrees" and no-op.
app.delete("/repos/worktrees", async (c) => {
  const body = (await c.req.json()) as DeleteRepoWorktreeRequest;
  if (!body.path) return c.json({ error: "path is required" }, 400);
  try {
    return c.json(await deleteRepoWorktree(body));
  } catch (err: any) {
    // Signal the dirty and unmerged cases explicitly so the client can offer to
    // force rather than having to match on the message text.
    if (err instanceof WorktreeDirtyError) {
      return c.json({ error: err.message, needsForce: true, changes: err.changes }, 409);
    }
    if (err instanceof BranchUnmergedError) {
      return c.json({ error: err.message, needsBranchForce: true, branch: err.branch }, 409);
    }
    return c.json({ error: err?.message || "Failed to delete worktree" }, 400);
  }
});

app.delete("/repos/:alias", (c) => {
  const alias = c.req.param("alias");
  removeRepo(alias);
  return c.json({ ok: true });
});

app.get("/repos/scan", (c) => {
  return c.json(scanBasePath());
});

app.get("/repos/worktrees", async (c) => {
  return c.json(await discoverRepoWorktrees());
});

app.post("/repos/worktrees", async (c) => {
  const body = (await c.req.json()) as CreateRepoWorktreeRequest;
  if (!body.repoAlias || !body.branch) {
    return c.json({ error: "repoAlias and branch are required" }, 400);
  }
  try {
    return c.json(await createRepoWorktree(body), 201);
  } catch (err: any) {
    return c.json({ error: err?.message || "Failed to create worktree" }, 400);
  }
});

app.get("/repos/:alias/branches", async (c) => {
  try {
    return c.json(await listRepoBranches(c.req.param("alias")));
  } catch (err: any) {
    return c.json({ error: err?.message || "Failed to list branches" }, 400);
  }
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


// ─── Health check ───

async function checkTool(cmd: string, args: string[]): Promise<{ installed: boolean; version: string }> {
  try {
    const proc = spawnTool(cmd, args, { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return { installed: false, version: "" };
    return { installed: true, version: stdout.trim().split("\n")[0] };
  } catch {
    return { installed: false, version: "" };
  }
}

app.get("/health", async (c) => {
  const [tmux, claude, cursor, codex, git, gh, bun, jq, psql, ngrok] = await Promise.all([
    checkTool("tmux", ["-V"]),
    checkTool("claude", ["--version"]),
    checkTool("agent", ["--version"]),
    checkTool("codex", ["--version"]),
    checkTool("git", ["--version"]),
    checkTool("gh", ["--version"]),
    checkTool("bun", ["--version"]),
    checkTool("jq", ["--version"]), // plan-hook.sh exits silently without it
    checkTool("psql", ["--version"]),
    checkTool("ngrok", ["version"]), // ngrok uses a subcommand, not --version
  ]);
  return c.json({ tmux, claude, cursor, codex, git, gh, bun, jq, psql, ngrok });
});

// ─── Status (first-run detection) ───

app.get("/status", (c) => {
  const repos = getRepos();
  return c.json({
    firstRun: !hasReposFile() && repos.length > 0, // has legacy repos but no repos.json
    needsSetup: !hasBasePath() && !hasReposFile(),
    basePath: getBasePath(),
    repoCount: repos.length,
    hasReposFile: hasReposFile(),
  });
});

// ─── Custom quick actions ───

app.get("/quick-actions", (c) => {
  return c.json(getCustomActions());
});

app.post("/quick-actions", async (c) => {
  const body = await c.req.json();
  if (!body.label || !body.prompt) {
    return c.json({ error: "label and prompt are required" }, 400);
  }
  const action = saveCustomAction({
    label: body.label,
    hint: body.hint || "",
    prompt: body.prompt,
  });
  return c.json(action, 201);
});

app.delete("/quick-actions/:id", (c) => {
  const id = c.req.param("id");
  deleteCustomAction(id);
  return c.json({ ok: true });
});

// ─── MCP Servers ───

app.get("/mcp-servers", (c) => {
  return c.json(getMcpServers());
});

app.post("/mcp-servers", async (c) => {
  const body = await c.req.json();
  if (!body.name || !body.command) {
    return c.json({ error: "name and command are required" }, 400);
  }
  addMcpServer({
    name: body.name,
    command: body.command,
    args: body.args || [],
    env: body.env || undefined,
  });
  return c.json({ ok: true }, 201);
});

app.delete("/mcp-servers/:name", (c) => {
  const name = c.req.param("name");
  removeMcpServer(name);
  return c.json({ ok: true });
});

// ─── Preferences ───

app.get("/preferences", (c) => {
  return c.json(getPreferences());
});

app.patch("/preferences", async (c) => {
  const body = await c.req.json();
  const current = getPreferences();
  const merged = { ...current, ...body };
  savePreferences(merged);
  return c.json(merged);
});

// ─── Meta property presets ───

app.get("/meta-properties", (c) => {
  return c.json(getMetaPropertyPresets());
});

app.put("/meta-properties", async (c) => {
  const body = await c.req.json();
  if (!Array.isArray(body)) {
    return c.json({ error: "body must be an array" }, 400);
  }
  saveMetaPropertyPresets(body);
  return c.json({ ok: true });
});

// ─── Ngrok basic auth ───

app.get("/ngrok-basic-auth", (c) => {
  const value = getNgrokBasicAuth();
  return c.json({ configured: !!value });
});

app.put("/ngrok-basic-auth", async (c) => {
  const body = (await c.req.json()) as { value: string };
  if (!body.value || !body.value.includes(":")) {
    return c.json({ error: "Format must be user:password" }, 400);
  }
  setNgrokBasicAuth(body.value);
  return c.json({ ok: true });
});

app.delete("/ngrok-basic-auth", (c) => {
  deleteNgrokBasicAuth();
  return c.json({ ok: true });
});

export default app;
