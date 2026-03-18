import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import Anthropic from "@anthropic-ai/sdk";
import { upsertPr, updatePr, listPrs, addNote, listNotes } from "../services/db";
import { listSessions, capturePaneSnapshot } from "../services/tmux";
import { detectStatus } from "../services/status";

const app = new Hono();

const SYSTEM_PROMPT = `You are Jacek, the project overseer for AgentDock. You help the user stay organized across all their Claude coding sessions.

You have tools to:
- Track and query PRs across sessions
- Check what each session is working on
- Read/write shared notes for coordination

Be concise. Use markdown tables when showing lists. Group PRs by feature when relevant.`;

// Tool definitions for Claude API
const TOOLS: Anthropic.Tool[] = [
  {
    name: "register_pr",
    description: "Register or update a pull request in the shared tracker.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: "Repository name" },
        url: { type: "string", description: "PR URL" },
        branch: { type: "string" },
        title: { type: "string" },
        status: { type: "string", enum: ["open", "merged", "closed", "draft", "review"] },
        feature: { type: "string" },
        ticket_id: { type: "string" },
        session_name: { type: "string" },
      },
      required: ["repo", "url"],
    },
  },
  {
    name: "list_prs",
    description: "List tracked pull requests with optional filters.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: { type: "string" },
        feature: { type: "string" },
        status: { type: "string", enum: ["open", "merged", "closed", "draft", "review"] },
        session_name: { type: "string" },
      },
    },
  },
  {
    name: "update_pr",
    description: "Update a tracked PR's status or metadata.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string" },
        status: { type: "string", enum: ["open", "merged", "closed", "draft", "review"] },
        title: { type: "string" },
        feature: { type: "string" },
      },
      required: ["url"],
    },
  },
  {
    name: "list_sessions",
    description: "List all active AgentDock sessions with their current status.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_session_output",
    description: "Get recent terminal output from a specific session.",
    input_schema: {
      type: "object" as const,
      properties: {
        session_name: { type: "string" },
        lines: { type: "number" },
      },
      required: ["session_name"],
    },
  },
  {
    name: "add_note",
    description: "Store a shared note.",
    input_schema: {
      type: "object" as const,
      properties: {
        key: { type: "string" },
        content: { type: "string" },
        session_name: { type: "string" },
      },
      required: ["key", "content"],
    },
  },
  {
    name: "list_notes",
    description: "List shared notes, optionally filtered by key.",
    input_schema: {
      type: "object" as const,
      properties: { key: { type: "string" } },
    },
  },
];

// Execute a tool call
async function executeTool(name: string, input: Record<string, any>): Promise<string> {
  switch (name) {
    case "register_pr":
      return JSON.stringify(upsertPr(input as any));
    case "list_prs":
      return JSON.stringify(listPrs(input as any));
    case "update_pr": {
      const { url, ...updates } = input;
      return JSON.stringify(updatePr(url, updates));
    }
    case "list_sessions": {
      const sessions = await listSessions();
      const results = [];
      for (const s of sessions) {
        const snap = await capturePaneSnapshot(s.name);
        let status = "unknown";
        if (snap.ok) {
          status = detectStatus(snap.data.content, snap.data.cursorY, snap.data.scrollPosition, snap.data.command || "", s.name);
        }
        results.push({ name: s.name, status, path: s.path });
      }
      return JSON.stringify(results);
    }
    case "get_session_output": {
      const snap = await capturePaneSnapshot(input.session_name);
      if (!snap.ok) return JSON.stringify({ error: `Session not found: ${input.session_name}` });
      const lines = snap.data.content.split("\n");
      const n = input.lines || 50;
      return lines.slice(-n).join("\n");
    }
    case "add_note":
      return JSON.stringify(addNote(input as any));
    case "list_notes":
      return JSON.stringify(listNotes(input.key));
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// Conversation history (in-memory, per server lifetime)
let conversationHistory: Anthropic.MessageParam[] = [];

app.post("/chat", async (c) => {
  const { message, reset } = await c.req.json();

  if (reset) {
    conversationHistory = [];
    return c.json({ ok: true });
  }

  if (!message) {
    return c.json({ error: "message is required" }, 400);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json({ error: "ANTHROPIC_API_KEY not set" }, 500);
  }

  const client = new Anthropic({ apiKey });

  // Add user message
  conversationHistory.push({ role: "user", content: message });

  return streamSSE(c, async (stream) => {
    let continueLoop = true;

    while (continueLoop) {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages: conversationHistory,
      });

      // Check for tool use
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

      if (toolUseBlocks.length > 0) {
        // Add assistant response with tool calls
        conversationHistory.push({ role: "assistant", content: response.content });

        // Execute tools and collect results
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of toolUseBlocks) {
          if (block.type === "tool_use") {
            await stream.writeSSE({ data: JSON.stringify({ type: "tool_call", name: block.name }) });
            const result = await executeTool(block.name, block.input as Record<string, any>);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: result,
            });
          }
        }

        // Send tool results back
        conversationHistory.push({ role: "user", content: toolResults });

        // Also stream any text that came with the tool use
        for (const block of response.content) {
          if (block.type === "text" && block.text) {
            await stream.writeSSE({ data: JSON.stringify({ type: "text", text: block.text }) });
          }
        }
      } else {
        // No tool use — stream the text response
        for (const block of response.content) {
          if (block.type === "text") {
            await stream.writeSSE({ data: JSON.stringify({ type: "text", text: block.text }) });
          }
        }
        // Add assistant response to history
        conversationHistory.push({ role: "assistant", content: response.content });
        continueLoop = false;
      }
    }

    await stream.writeSSE({ data: JSON.stringify({ type: "done" }) });
  });
});

// Get conversation history (for UI init)
app.get("/history", (c) => {
  const messages = conversationHistory.map((m) => {
    if (m.role === "user" && typeof m.content === "string") {
      return { role: "user", text: m.content };
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const text = m.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { role: "assistant", text };
    }
    return null;
  }).filter(Boolean);
  return c.json({ messages });
});

export default app;
