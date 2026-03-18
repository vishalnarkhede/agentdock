import { Hono } from "hono";
import { upsertPr, updatePr, listPrs, addNote, listNotes } from "../services/db";
import { listSessions, capturePaneSnapshot } from "../services/tmux";
import { detectStatus } from "../services/status";

const app = new Hono();

// ─── Tool Definitions ───

const TOOLS = [
  {
    name: "register_pr",
    description: "Register or update a pull request in the shared tracker. Call this after creating a PR.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository name (e.g. 'chat', 'django')" },
        url: { type: "string", description: "PR URL" },
        branch: { type: "string", description: "Branch name" },
        title: { type: "string", description: "PR title" },
        status: { type: "string", enum: ["open", "merged", "closed", "draft", "review"], description: "PR status" },
        feature: { type: "string", description: "Feature or epic this PR belongs to" },
        ticket_id: { type: "string", description: "Linear/Jira ticket ID (e.g. MOD-267)" },
        session_name: { type: "string", description: "Name of the session that created this PR" },
      },
      required: ["repo", "url"],
    },
  },
  {
    name: "list_prs",
    description: "List tracked pull requests with optional filters. Returns PRs grouped by feature if no filters specified.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Filter by repository name" },
        feature: { type: "string", description: "Filter by feature/epic" },
        status: { type: "string", enum: ["open", "merged", "closed", "draft", "review"], description: "Filter by status" },
        session_name: { type: "string", description: "Filter by session that created the PR" },
      },
    },
  },
  {
    name: "update_pr",
    description: "Update a tracked pull request's status or metadata.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "PR URL to update" },
        status: { type: "string", enum: ["open", "merged", "closed", "draft", "review"] },
        title: { type: "string" },
        feature: { type: "string" },
        ticket_id: { type: "string" },
      },
      required: ["url"],
    },
  },
  {
    name: "list_sessions",
    description: "List all active AgentDock sessions with their current status (working, waiting, error).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_session_output",
    description: "Get the recent terminal output from a specific session.",
    inputSchema: {
      type: "object",
      properties: {
        session_name: { type: "string", description: "Session name to get output from" },
        lines: { type: "number", description: "Number of lines to return (default 50)" },
      },
      required: ["session_name"],
    },
  },
  {
    name: "add_note",
    description: "Store a shared note that other sessions can read. Use for decisions, context, or coordination.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Category key (e.g. 'decision', 'blocker', 'context')" },
        content: { type: "string", description: "Note content" },
        session_name: { type: "string", description: "Session that created this note" },
      },
      required: ["key", "content"],
    },
  },
  {
    name: "list_notes",
    description: "List shared notes, optionally filtered by key.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Filter by category key" },
      },
    },
  },
];

// ─── Tool Handlers ───

async function handleToolCall(name: string, args: Record<string, any>): Promise<any> {
  switch (name) {
    case "register_pr":
      return upsertPr({
        repo: args.repo,
        url: args.url,
        branch: args.branch,
        title: args.title,
        status: args.status,
        feature: args.feature,
        ticket_id: args.ticket_id,
        session_name: args.session_name,
      });

    case "list_prs":
      return listPrs({
        repo: args.repo,
        feature: args.feature,
        status: args.status,
        session_name: args.session_name,
      });

    case "update_pr":
      return updatePr(args.url, {
        status: args.status,
        title: args.title,
        feature: args.feature,
        ticket_id: args.ticket_id,
      });

    case "list_sessions": {
      const tmuxSessions = await listSessions();
      const results = [];
      for (const s of tmuxSessions) {
        const snap = await capturePaneSnapshot(s.name);
        let status = "unknown";
        if (snap.ok) {
          status = detectStatus(snap.data.content, snap.data.cursorY, snap.data.scrollPosition, snap.data.command || "", s.name);
        }
        results.push({ name: s.name, status, path: s.path });
      }
      return results;
    }

    case "get_session_output": {
      const snap = await capturePaneSnapshot(args.session_name);
      if (!snap.ok) return { error: `Session not found: ${args.session_name}` };
      const lines = snap.data.content.split("\n");
      const n = args.lines || 50;
      return { output: lines.slice(-n).join("\n") };
    }

    case "add_note":
      return addNote({
        key: args.key,
        content: args.content,
        session_name: args.session_name,
      });

    case "list_notes":
      return listNotes(args.key);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP JSON-RPC Endpoint ───

const MCP_SERVER_INFO = {
  name: "agentdock",
  version: "1.0.0",
  protocolVersion: "2024-11-05",
};

app.post("/", async (c) => {
  const body = await c.req.json();

  // Handle JSON-RPC request
  const { jsonrpc, id, method, params } = body;

  if (jsonrpc !== "2.0") {
    return c.json({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid JSON-RPC" } });
  }

  try {
    let result: any;

    switch (method) {
      case "initialize":
        result = {
          protocolVersion: MCP_SERVER_INFO.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_INFO.name, version: MCP_SERVER_INFO.version },
        };
        break;

      case "notifications/initialized":
        // Client ack — no response needed
        return c.json({ jsonrpc: "2.0", id, result: {} });

      case "tools/list":
        result = { tools: TOOLS };
        break;

      case "tools/call": {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        const toolResult = await handleToolCall(toolName, toolArgs);
        result = {
          content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }],
        };
        break;
      }

      case "ping":
        result = {};
        break;

      default:
        return c.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
    }

    return c.json({ jsonrpc: "2.0", id, result });
  } catch (err: any) {
    return c.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: err.message },
    });
  }
});

// GET for SSE transport (optional, for future use)
app.get("/", (c) => {
  return c.json({ name: MCP_SERVER_INFO.name, version: MCP_SERVER_INFO.version });
});

export default app;
