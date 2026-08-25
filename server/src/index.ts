import { Hono } from "hono";
import { cors } from "hono/cors";
import sessionsRoutes from "./routes/sessions";
import reposRoutes from "./routes/repos";
import gitRoutes from "./routes/git";
import templateRoutes from "./routes/templates";
import uploadRoutes from "./routes/upload";
import settingsRoutes from "./routes/settings";
import dbRoutes from "./routes/db";
import reviewRoutes from "./routes/review";
import planRoutes from "./routes/plan";
import worktreeRoutes from "./routes/worktrees";
import codeRoutes from "./routes/code";
import housekeepingRoutes from "./routes/housekeeping";
import ngrokRoutes from "./routes/ngrok";
import fsRoutes from "./routes/fs";
import authRoutes, { authMiddleware, verifyWsCookie } from "./routes/auth";
import { handleWsOpen, handleWsMessage, handleWsClose } from "./routes/ws";
import { syncRepos, syncHooksToClaudeSettings } from "./services/config";
import { migrateUnnamedSessions } from "./services/session-manager";

const app = new Hono();

app.use("*", cors());

// Auth: login/status endpoints are public, everything else requires session cookie
app.route("/api/auth", authRoutes);
app.use("/api/*", authMiddleware());

app.route("/api/sessions", sessionsRoutes);
app.route("/api/repos", reposRoutes);
app.route("/api/git", gitRoutes);
app.route("/api/templates", templateRoutes);
app.route("/api/upload", uploadRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/db", dbRoutes);
app.route("/api/review", reviewRoutes);
app.route("/api/plan", planRoutes);
app.route("/api/worktrees", worktreeRoutes);
app.route("/api/code", codeRoutes);
app.route("/api/housekeeping", housekeepingRoutes);
app.route("/api/ngrok", ngrokRoutes);
app.route("/api/fs", fsRoutes);

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
      /* How much scrollback the viewer wants painted at connect. The terminal's
         own setting is the reader's, so it travels with the connection rather
         than being guessed at here. */
      const scrollback = Number(url.searchParams.get("scrollback")) || undefined;
      if (sessionName) {
        const upgraded = server.upgrade(req, { data: { sessionName, scrollback } as any });
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
        handleWsOpen(ws, sessionName, (ws.data as any)?.scrollback);
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

// Name any existing unnamed Claude sessions so they can be resumed after reboot
migrateUnnamedSessions().catch(console.error);
