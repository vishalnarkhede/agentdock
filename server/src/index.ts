import { Hono } from "hono";
import { cors } from "hono/cors";
import sessionsRoutes from "./routes/sessions";
import reposRoutes from "./routes/repos";
import ticketsRoutes from "./routes/tickets";
import gitRoutes from "./routes/git";
import templateRoutes from "./routes/templates";
import quickRoutes from "./routes/quick";
import uploadRoutes from "./routes/upload";
import settingsRoutes from "./routes/settings";
import dbRoutes from "./routes/db";
import authRoutes, { authMiddleware, verifyWsCookie } from "./routes/auth";
import { handleWsOpen, handleWsMessage, handleWsClose } from "./routes/ws";
import mcpRoutes from "./routes/mcp";
import jacekRoutes from "./routes/jacek";
import { syncRepos, syncHooksToClaudeSettings, addMcpServer } from "./services/config";

const app = new Hono();

app.use("*", cors());

// Auth: login/status endpoints are public, everything else requires session cookie
app.route("/api/auth", authRoutes);
app.use("/api/*", authMiddleware());

app.route("/api/sessions", sessionsRoutes);
app.route("/api/repos", reposRoutes);
app.route("/api/tickets", ticketsRoutes);
app.route("/api/git", gitRoutes);
app.route("/api/templates", templateRoutes);
app.route("/api/quick", quickRoutes);
app.route("/api/upload", uploadRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/db", dbRoutes);
app.route("/api/jacek", jacekRoutes);

// MCP endpoint — no auth (local only, used by Claude sessions)
app.route("/mcp", mcpRoutes);

// Health check
app.get("/api/health", (c) => c.json({ ok: true }));

const PORT = parseInt(process.env.PORT || "4800");

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade for /ws/sessions/:name
    if (url.pathname.startsWith("/ws/sessions/")) {
      if (!verifyWsCookie(req)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const sessionName = url.pathname.replace("/ws/sessions/", "");
      if (sessionName) {
        const upgraded = server.upgrade(req, { data: { sessionName } as any });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }
    }

    return app.fetch(req, { ip: server.requestIP(req) });
  },
  websocket: {
    open(ws) {
      const sessionName = (ws.data as any)?.sessionName;
      if (sessionName) {
        handleWsOpen(ws, sessionName);
      }
    },
    message(ws, message) {
      handleWsMessage(ws, message);
    },
    close(ws) {
      handleWsClose(ws);
    },
  },
});

console.log(`Server running at http://localhost:${PORT}`);

// Periodically sync repos with base path
syncRepos();
setInterval(syncRepos, 10_000);

// Install Claude Code hooks for deterministic status detection
syncHooksToClaudeSettings();

// Register AgentDock MCP server so all Claude sessions can use it
addMcpServer({ name: "agentdock", type: "http", url: `http://localhost:${PORT}/mcp` });
