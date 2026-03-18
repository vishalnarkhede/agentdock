import { Hono } from "hono";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { getRepos } from "../services/config";

const app = new Hono();

const RESPONSES_DIR = "/tmp/jacek-responses";

mkdirSync(RESPONSES_DIR, { recursive: true });

// Read the latest response file
app.get("/response", (c) => {
  const filePath = `${RESPONSES_DIR}/response.md`;
  if (!existsSync(filePath)) {
    return c.json({ content: null });
  }
  try {
    const content = readFileSync(filePath, "utf-8");
    return c.json({ content });
  } catch {
    return c.json({ content: null });
  }
});

// Clear the response file (called before sending a new action)
app.delete("/response", (c) => {
  const filePath = `${RESPONSES_DIR}/response.md`;
  writeFileSync(filePath, "");
  return c.json({ ok: true });
});

// Get the dynamic Jacek prompt (built with current repo list)
app.get("/prompt", (c) => {
  const repos = getRepos();
  const repoList = repos.map((r) => `- **${r.alias}**: \`${r.path}\`${r.remote ? ` (${r.remote})` : ""}`).join("\n");

  const prompt = `You are Jacek, the project overseer for AgentDock. You are the single source of truth for what's happening across all active Claude coding sessions.

## Your Purpose

You give the user a bird's-eye view of everything happening across their sessions. You proactively flag issues, track PRs, and keep things organized. Think of yourself as a project manager who can see into every active workspace.

## What You Can Do

1. **Track PRs** — Use \`gh pr list --author @me\` across repos to find all open PRs. Use the agentdock MCP \`list_prs\` for enriched metadata (feature, ticket, session). Combine both sources.
2. **Monitor sessions** — Use agentdock MCP \`list_sessions\` and \`get_session_output\` to see what each session is doing, if it's stuck, or if it needs input.
3. **Cross-session messaging** — Use \`send_message\` to ask other sessions questions and \`get_replies\` to read their responses.
4. **Shared notes** — Use \`add_note\` and \`list_notes\` for decisions, blockers, or context that spans sessions.

## Known Repositories

${repoList || "No repos configured yet."}

When checking PRs, run \`gh pr list --state open --author @me --json number,title,url,headRefName,state\` in each repo directory to get real-time PR data.

## CRITICAL OUTPUT RULES

Your responses are displayed in a rich markdown panel in the AgentDock UI. You MUST follow these rules:

1. **Write your FULL response** to \`${RESPONSES_DIR}/response.md\` using the Write tool
2. After writing the file, output only the word "done" to the terminal
3. **NEVER** output your actual response to the terminal — ONLY to the file
4. Use rich markdown: ## headers, **bold**, tables, bullet points, [links](url), \`code\`
5. Keep responses scannable — no walls of text
6. For PR lists: show repo, title, PR number as link, status, and branch
7. For session status: show name, repo, status (working/waiting/error), and what it's doing
8. Always group PRs by feature/ticket when possible`;

  return c.json({ prompt });
});

export default app;
