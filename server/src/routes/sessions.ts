import { Hono } from "hono";
import { listSessions, capturePaneSnapshot, sendKeysRaw, sendSpecialKey } from "../services/tmux";
import {
  getSessionMeta,
  getPlan,
  PREFIX,
  getSessionAgentType,
  getSessionSkipPerms,
  getSessionParent,
  getSessionChildren,
  getSessionType,
  getSessionOrder,
  saveSessionOrder,
} from "../services/config";
import { detectStatus, extractStatusLine } from "../services/status";
import {
  startSession,
  stopSession,
  stopAllSessions,
} from "../services/session-manager";
import type { CreateSessionRequest, SessionInfo, AgentType } from "../types";

const app = new Hono();

app.get("/", async (c) => {
  const sessions = await listSessions(PREFIX);
  const enriched: SessionInfo[] = await Promise.all(
    sessions.map(async (s) => {
      let status: SessionInfo["status"] = "unknown";
      let statusLine: SessionInfo["statusLine"] = undefined;
      const snap = await capturePaneSnapshot(s.name);
      if (snap.ok) {
        status = detectStatus(snap.data.content, snap.data.cursorY, snap.data.scrollPosition, snap.data.command);
        // Only use statusLine when agent isn't actively working — otherwise it's stale from a previous task
        if (status !== "working") {
          statusLine = extractStatusLine(snap.data.content) ?? undefined;
        }
      }
      const agentType = getSessionAgentType(s.name) as AgentType | null;
      const parentSession = getSessionParent(s.name) ?? undefined;
      const children = getSessionChildren(s.name);
      const sessionType = getSessionType(s.name) ?? undefined;
      return {
        name: s.name,
        displayName: s.name.replace(`${PREFIX}-`, ""),
        windows: s.windows,
        attached: s.attached,
        created: s.created,
        path: s.path,
        worktrees: getSessionMeta(s.name),
        status,
        statusLine,
        agentType: agentType || undefined,
        parentSession,
        children: children.length > 0 ? children : undefined,
        sessionType,
      };
    }),
  );
  // Sort by saved order (unordered sessions appended at end)
  const order = getSessionOrder();
  if (order.length > 0) {
    const orderMap = new Map(order.map((name, idx) => [name, idx]));
    enriched.sort((a, b) => {
      const ai = orderMap.get(a.name) ?? Number.MAX_SAFE_INTEGER;
      const bi = orderMap.get(b.name) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });
  }

  return c.json(enriched);
});

app.put("/reorder", async (c) => {
  const body = await c.req.json() as { order: string[] };
  if (!body.order || !Array.isArray(body.order)) {
    return c.json({ error: "order must be an array of session names" }, 400);
  }
  saveSessionOrder(body.order);
  return c.json({ ok: true });
});

app.post("/", async (c) => {
  const body = (await c.req.json()) as CreateSessionRequest;
  if (!body.targets || !Array.isArray(body.targets)) {
    return c.json({ error: "targets must be an array" }, 400);
  }
  try {
    const created = await startSession(body);
    return c.json({ sessions: created }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.get("/:name/plan", async (c) => {
  const name = c.req.param("name");
  const plan = getPlan(name);
  return c.json({ plan });
});

app.get("/:name/output", async (c) => {
  const name = c.req.param("name");
  const lines = parseInt(c.req.query("lines") || "50", 10);
  const snap = await capturePaneSnapshot(name);
  if (!snap.ok) {
    return c.json({ error: snap.error }, 404);
  }
  // Strip ANSI codes and return plain text
  const content = snap.data.content
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "");
  const allLines = content.split("\n");
  const output = allLines.slice(-lines).join("\n");
  const status = detectStatus(snap.data.content, snap.data.cursorY, snap.data.scrollPosition, snap.data.command);
  const statusLine = status !== "working" ? (extractStatusLine(snap.data.content) ?? undefined) : undefined;
  return c.json({ output, status, statusLine });
});

app.get("/:name/children", async (c) => {
  const name = c.req.param("name");
  const childNames = getSessionChildren(name);
  if (childNames.length === 0) {
    return c.json([]);
  }
  const allSessions = await listSessions(PREFIX);
  const childSessions = await Promise.all(
    childNames.map(async (childName) => {
      const s = allSessions.find((sess) => sess.name === childName);
      if (!s) return null;
      let status: SessionInfo["status"] = "unknown";
      let statusLine: SessionInfo["statusLine"] = undefined;
      const snap = await capturePaneSnapshot(s.name);
      if (snap.ok) {
        status = detectStatus(snap.data.content, snap.data.cursorY, snap.data.scrollPosition, snap.data.command);
        if (status !== "working") {
          statusLine = extractStatusLine(snap.data.content) ?? undefined;
        }
      }
      const agentType = getSessionAgentType(s.name) as AgentType | null;
      return {
        name: s.name,
        displayName: s.name.replace(`${PREFIX}-`, ""),
        windows: s.windows,
        attached: s.attached,
        created: s.created,
        path: s.path,
        worktrees: getSessionMeta(s.name),
        status,
        statusLine,
        agentType: agentType || undefined,
        parentSession: name,
      } as SessionInfo;
    }),
  );
  return c.json(childSessions.filter(Boolean));
});

app.post("/:name/open-iterm", async (c) => {
  const name = c.req.param("name");
  const script = `
    tell application "iTerm2"
      activate
      create window with default profile
      tell current session of current window
        write text "tmux attach -t ${name}"
      end tell
    end tell
  `;
  const proc = Bun.spawn(["osascript", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    return c.json({ error: stderr.trim() || "Failed to open iTerm" }, 500);
  }
  return c.json({ ok: true });
});

app.post("/:name/input", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json() as { text: string };
  if (!body.text) return c.json({ error: "text is required" }, 400);
  await sendKeysRaw(name, body.text);
  await sendSpecialKey(name, "Enter");
  return c.json({ ok: true });
});

app.post("/:name/switch-agent", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json() as { agentType: AgentType; contextMessage?: string };
  
  if (!body.agentType || !["claude", "cursor"].includes(body.agentType)) {
    return c.json({ error: "agentType must be 'claude' or 'cursor'" }, 400);
  }
  
  const currentAgent = getSessionAgentType(name) || "claude";
  if (currentAgent === body.agentType) {
    return c.json({ error: `Session is already using ${body.agentType}` }, 400);
  }

  // Stream progress via SSE
  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (step: string, done = false) => {
          const data = JSON.stringify({ step, done });
          controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
        };

        try {
          const { mkdirSync, writeFileSync } = await import("fs");
          const contextDir = "/tmp/agentdock-context";
          mkdirSync(contextDir, { recursive: true });
          const contextFile = `${contextDir}/${name}.md`;

          // Step 1: Compress conversation
          send(`Compressing ${currentAgent} conversation...`);
          const compressCmd = currentAgent === "claude" ? "/compact" : "/summarize";
          await sendKeysRaw(name, compressCmd);
          await sendSpecialKey(name, "Enter");

          // Wait a fixed time for compression to finish
          // Claude /compact and Cursor /summarize typically take 5-10s
          await new Promise(r => setTimeout(r, 8000));

          // Step 2: Capture context
          send("Capturing session context...");
          let contextContent = "";
          const snap = await capturePaneSnapshot(name);
          if (snap.ok && snap.data.content) {
            contextContent = snap.data.content
              .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
              .replace(/[┌┐└┘├┤┬┴┼─│═║╔╗╚╝╠╣╦╩╬▶︎⬢]/g, "")
              .replace(/\s*[→←↑↓▸▹►▻⏎]\s*/g, " ")
              .split('\n')
              .map((l: string) => l.trim())
              .filter((l: string) => l.length > 0)
              .join('\n');
          }

          const contextHeader = `# Agent Switch Context\n\nSwitched from **${currentAgent}** to **${body.agentType}**.\nThe previous agent's conversation was compressed before switching.\n`;
          const userContext = body.contextMessage ? `\n## User Instructions\n\n${body.contextMessage}\n` : "";
          const terminalContext = contextContent
            ? `\n## Previous Session (compressed)\n\n\`\`\`\n${contextContent.slice(-4000)}\n\`\`\`\n`
            : "";
          writeFileSync(contextFile, contextHeader + userContext + terminalContext);

          // Step 3: Exit current agent
          send(`Exiting ${currentAgent}...`);
          await sendKeysRaw(name, "/exit");
          await sendSpecialKey(name, "Enter");
          await new Promise(r => setTimeout(r, 1000));

          await sendSpecialKey(name, "C-c");
          await new Promise(r => setTimeout(r, 500));
          await sendSpecialKey(name, "C-c");
          await new Promise(r => setTimeout(r, 1000));

          // Step 4: Wait for shell
          send("Waiting for shell prompt...");
          let gotShell = false;
          for (let i = 0; i < 10; i++) {
            const snap = await capturePaneSnapshot(name);
            if (snap.ok) {
              const lastLines = snap.data.content.split('\n').slice(-5).join('\n');
              if (/[$➜%#>]\s*$/.test(lastLines)) {
                gotShell = true;
                break;
              }
            }
            await new Promise(r => setTimeout(r, 500));
          }
          if (!gotShell) {
            await sendSpecialKey(name, "C-c");
            await new Promise(r => setTimeout(r, 1000));
          }

          // Step 5: Launch new agent with same permissions as original session
          const skipPerms = getSessionSkipPerms(name);
          send(`Starting ${body.agentType}${skipPerms ? " (yolo)" : ""}...`);
          
          const { writeSystemPromptFile } = await import("../services/session-manager");
          const sysPromptFile = writeSystemPromptFile(name);

          let agentCmd: string;
          if (body.agentType === "cursor") {
            agentCmd = skipPerms ? "agent --yolo" : "agent";
          } else {
            const base = skipPerms ? "claude --dangerously-skip-permissions" : "claude";
            agentCmd = `${base} --append-system-prompt-file ${sysPromptFile}`;
          }

          const contextPrompt = `Read ${contextFile} for context from the previous agent session, then continue the work.`;
          await sendKeysRaw(name, `${agentCmd} "${contextPrompt}"`);
          await sendSpecialKey(name, "Enter");

          const { saveSessionAgentType } = await import("../services/config");
          saveSessionAgentType(name, body.agentType);

          send(`Switched to ${body.agentType}`, true);
          controller.close();
        } catch (err: any) {
          const data = JSON.stringify({ step: `Error: ${err.message}`, done: true, error: true });
          controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
          controller.close();
        }
      }
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    }
  );
});

app.delete("/:name", async (c) => {
  const name = c.req.param("name");
  try {
    await stopSession(name);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.delete("/", async (c) => {
  try {
    await stopAllSessions();
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;
