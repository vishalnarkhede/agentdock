import { syncHooksToClaudeSettings, getHookInstallState, REQUIRED_HOOK_EVENTS } from "../services/config";
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
  getAgentMcpNames,
  getPreferences,
  savePreferences,
  getMetaPropertyPresets,
  saveMetaPropertyPresets,
  getNgrokBasicAuth,
  setNgrokBasicAuth,
  deleteNgrokBasicAuth,
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

app.get("/repos/scan", (c) => {
  return c.json(scanBasePath());
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

// ─── What MCP servers the agents have (read-only) ───

app.get("/agent-mcp", (c) => {
  return c.json({ names: getAgentMcpNames() });
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

// GET /api/settings/hooks — is status detection actually wired up?
//
// Without these five hooks AgentDock has to guess an agent's state by reading
// its terminal, which is the difference between knowing an agent is blocked
// and finding out ninety seconds later.
app.get("/hooks", (c) => {
  return c.json({ ...getHookInstallState(), events: REQUIRED_HOOK_EVENTS });
});

// POST /api/settings/hooks — install the missing ones. Idempotent.
// Deliberately user-initiated: it writes to ~/.claude/settings.json, which is
// outside AgentDock's own config directory.
app.post("/hooks", (c) => {
  try {
    syncHooksToClaudeSettings();
    /* The state's own `ok` means "every hook is installed", which is not the
       same claim as "the request worked" — and the spread was silently winning
       over a literal `ok: true` that TypeScript flagged as dead. The status
       code says whether the request worked; the body says what the state is. */
    return c.json({ ...getHookInstallState(), events: REQUIRED_HOOK_EVENTS });
  } catch (err: any) {
    return c.json({ ok: false, error: err?.message || "install failed" }, 500);
  }
});

export default app;
